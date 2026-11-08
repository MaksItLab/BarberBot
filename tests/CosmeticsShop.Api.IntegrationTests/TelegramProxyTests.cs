using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;
using CosmeticsShop.Infrastructure;
using CosmeticsShop.Infrastructure.Telegram;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace CosmeticsShop.Api.IntegrationTests;

public sealed class TelegramProxyTests
{
    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("socks5://127.0.0.1:1080")]
    [InlineData("socks5://127.0.0.1:1080/")]
    [InlineData("socks4a://localhost:1080")]
    [InlineData("http://127.0.0.1:8118")]
    [InlineData("https://proxy.example.test:443")]
    public void AcceptsEmptyOrSupportedProxyUrl(string value) => Assert.True(TelegramHttp.IsValidProxyUrl(value));

    [Theory]
    [InlineData("127.0.0.1:1080")]
    [InlineData("vless://uuid@host.example.test:443")]
    [InlineData("socks5h://127.0.0.1:1080")]
    [InlineData("socks5://user:secret@127.0.0.1:1080")]
    [InlineData("http://127.0.0.1:8118/path")]
    [InlineData("http://127.0.0.1:8118/?a=1")]
    public void RejectsUnsupportedProxyUrl(string value) => Assert.False(TelegramHttp.IsValidProxyUrl(value));

    [Fact]
    public void StartupRejectsInvalidProxyUrlWithoutEchoingIt()
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> {
            ["Telegram:ProxyUrl"] = "vless://secret-key@host.example.test:443"
        }).Build();
        using var provider = new ServiceCollection().AddLogging().AddInfrastructure(configuration).BuildServiceProvider();
        var error = Assert.Throws<OptionsValidationException>(() => provider.GetRequiredService<IOptions<TelegramOptions>>().Value);
        Assert.Contains("Telegram:ProxyUrl", error.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("secret-key", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task HttpProxyReceivesConnectForTelegramHost()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var firstLine = ReadHttpProxyRequestLine(listener);
        using var client = TelegramHttp.CreateClient(new TelegramOptions { ProxyUrl = $"http://127.0.0.1:{port}" });

        await Assert.ThrowsAnyAsync<Exception>(() => client.GetAsync("https://api.telegram.org/bot123:secret/getMe"));

        Assert.Equal("CONNECT api.telegram.org:443 HTTP/1.1", await firstLine.WaitAsync(TimeSpan.FromSeconds(5)));
    }

    [Fact]
    public async Task Socks5ProxyGetsHostNameSoDnsIsResolvedRemotely()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var target = ReadSocks5Target(listener);
        using var client = TelegramHttp.CreateClient(new TelegramOptions { ProxyUrl = $"socks5://127.0.0.1:{port}" });

        await Assert.ThrowsAnyAsync<Exception>(() => client.GetAsync("https://api.telegram.org/bot123:secret/getMe"));

        Assert.Equal("api.telegram.org:443", await target.WaitAsync(TimeSpan.FromSeconds(5)));
    }

    [Fact]
    public async Task WorkerLogsProxyOnceAlertsAfterRepeatedFailuresAndReportsRecovery()
    {
        using var handler = new FlakyTransport(failures: 3);
        using var client = new HttpClient(handler);
        var logger = new CapturedLogger();
        using var worker = new TelegramBotWorker(new StaticOptions(new TelegramOptions {
            Enabled = true, BotToken = "123456:test-only-secret", MiniAppUrl = "https://shop.example.test/",
            ProxyUrl = "socks5://127.0.0.1:1080"
        }), logger, client, retryDelay: TimeSpan.FromMilliseconds(10), alertAfterFailures: 2);
        await worker.StartAsync(default);
        try
        {
            await handler.Recovered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await WaitUntil(() => logger.Entries.Any(entry => entry.Message.Contains("reachable again", StringComparison.Ordinal)));
        }
        finally { await worker.StopAsync(default); }

        var entries = logger.Entries.ToArray();
        Assert.Contains(entries, entry => entry.Level == LogLevel.Information &&
            entry.Message == "Telegram requests go through proxy socks5://127.0.0.1:1080.");
        Assert.Equal(3, entries.Count(entry => entry.Level == LogLevel.Warning));
        Assert.Single(entries, entry => entry.Level == LogLevel.Error && entry.Message.Contains("2 requests in a row", StringComparison.Ordinal));
        Assert.Contains(entries, entry => entry.Message == "Telegram API is reachable again after 3 failed requests.");
        Assert.DoesNotContain(entries, entry => entry.Message.Contains("test-only-secret", StringComparison.Ordinal));
    }

    private static async Task WaitUntil(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (!condition())
        {
            if (DateTime.UtcNow > deadline) throw new TimeoutException();
            await Task.Delay(10);
        }
    }

    private static Task<string> ReadHttpProxyRequestLine(TcpListener listener) => Task.Run(async () => {
        using var socket = await listener.AcceptTcpClientAsync();
        using var reader = new StreamReader(socket.GetStream(), Encoding.ASCII);
        return await reader.ReadLineAsync() ?? "";
    });

    private static Task<string> ReadSocks5Target(TcpListener listener) => Task.Run(async () => {
        using var socket = await listener.AcceptTcpClientAsync();
        var stream = socket.GetStream();
        var greeting = await ReadExactly(stream, 2);
        await ReadExactly(stream, greeting[1]);
        await stream.WriteAsync(new byte[] { 5, 0 }); // version 5, no authentication
        var request = await ReadExactly(stream, 4);   // version, command, reserved, address type
        if (request[3] != 3) return $"address type {request[3]} instead of a host name";
        var length = (await ReadExactly(stream, 1))[0];
        var host = Encoding.ASCII.GetString(await ReadExactly(stream, length));
        var port = await ReadExactly(stream, 2);
        return $"{host}:{(port[0] << 8) | port[1]}";
    });

    private static async Task<byte[]> ReadExactly(Stream stream, int count)
    {
        var buffer = new byte[count];
        await stream.ReadExactlyAsync(buffer);
        return buffer;
    }

    private sealed class StaticOptions(TelegramOptions value) : IOptionsMonitor<TelegramOptions>
    {
        public TelegramOptions CurrentValue => value;
        public TelegramOptions Get(string? name) => value;
        public IDisposable? OnChange(Action<TelegramOptions, string?> listener) => null;
    }

    private sealed class FlakyTransport(int failures) : HttpMessageHandler
    {
        public TaskCompletionSource Recovered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int calls;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var call = Interlocked.Increment(ref calls);
            if (call <= failures) throw new HttpRequestException("proxy down for https://api.telegram.org/bot123456:test-only-secret/getUpdates");
            if (call == failures + 1)
            {
                Recovered.TrySetResult();
                return new HttpResponseMessage(HttpStatusCode.OK)
                { Content = new StringContent("""{"ok":true,"result":[]}""", Encoding.UTF8, "application/json") };
            }
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            throw new InvalidOperationException("Unreachable");
        }
    }

    private sealed class CapturedLogger : ILogger<TelegramBotWorker>
    {
        public ConcurrentQueue<(LogLevel Level, string Message)> Entries { get; } = new();
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
            Entries.Enqueue((logLevel, formatter(state, exception)));
    }
}
