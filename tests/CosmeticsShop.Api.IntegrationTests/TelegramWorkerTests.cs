using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using CosmeticsShop.Infrastructure.Telegram;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace CosmeticsShop.Api.IntegrationTests;

public sealed class TelegramWorkerTests
{
    [Fact]
    public async Task BlockedChatDoesNotStopNextStartAndOffsetAcknowledgesProcessedUpdates()
    {
        using var handler = new BotTransport();
        using var client = new HttpClient(handler);
        var logger = new CapturedLogger();
        using var worker = new TelegramBotWorker(new MutableOptions(new TelegramOptions {
            Enabled = true, BotToken = "123456:test-only-secret", MiniAppUrl = "https://shop.example.test/"
        }), logger, client);
        await worker.StartAsync(default);
        try
        {
            await handler.Acknowledged.Task.WaitAsync(TimeSpan.FromSeconds(3));
            Assert.Equal(new long[] { 111, 222 }, handler.RepliedChats.ToArray());
            Assert.Equal("https://shop.example.test/", handler.ButtonUrl);
            Assert.Equal("Открыть магазин", handler.ButtonText);
            Assert.Contains(logger.Messages, message => message.Contains("unavailable", StringComparison.Ordinal));
            Assert.DoesNotContain(logger.Messages, message => message.Contains("test-only-secret", StringComparison.Ordinal)
                || message.Contains("sensitive-response-text", StringComparison.Ordinal));
        }
        finally { await worker.StopAsync(default); }
    }

    [Fact]
    public async Task DisabledBotRequiresNoTokenAndMakesNoNetworkCalls()
    {
        using var handler = new BotTransport();
        using var client = new HttpClient(handler);
        using var worker = new TelegramBotWorker(new MutableOptions(new TelegramOptions()), new CapturedLogger(), client);
        await worker.StartAsync(default);
        await worker.ExecuteTask!.WaitAsync(TimeSpan.FromSeconds(3));
        Assert.Equal(0, handler.RequestCount);
        await worker.StopAsync(default);
    }

    [Fact]
    public async Task NextStartUsesUpdatedUrlWithoutRestartingWorker()
    {
        var options = new MutableOptions(new TelegramOptions {
            Enabled = true, BotToken = "123456:test-only-secret", MiniAppUrl = "https://old.example.test/"
        });
        using var handler = new BotTransport(() => options.CurrentValue = new TelegramOptions {
            Enabled = true, BotToken = "123456:test-only-secret", MiniAppUrl = "https://new.example.test/"
        });
        using var client = new HttpClient(handler);
        using var worker = new TelegramBotWorker(options, new CapturedLogger(), client);
        await worker.StartAsync(default);
        try
        {
            await handler.Acknowledged.Task.WaitAsync(TimeSpan.FromSeconds(3));
            Assert.Equal(new[] { "https://old.example.test/", "https://new.example.test/" }, handler.ButtonUrls.ToArray());
        }
        finally { await worker.StopAsync(default); }
    }

    [Fact]
    public async Task TunnelFileReloadUpdatesUrlAndPreservesBotIdentity()
    {
        var directory = Path.Combine(Path.GetTempPath(), "cosmetics-tunnel-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var file = Path.Combine(directory, "appsettings.Tunnel.json");
        try
        {
            await File.WriteAllTextAsync(file, """{"Telegram":{"MiniAppUrl":"https://old.example.test/"}}""");
            using var configuration = (ConfigurationRoot)new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?> {
                    ["Telegram:BotToken"] = "123456:test-only-secret", ["Telegram:Enabled"] = "true"
                }).AddJsonFile(file, optional: false, reloadOnChange: true).Build();
            using var provider = new ServiceCollection().Configure<TelegramOptions>(configuration.GetSection("Telegram")).BuildServiceProvider();
            var options = provider.GetRequiredService<IOptionsMonitor<TelegramOptions>>();
            Assert.Equal("https://old.example.test/", options.CurrentValue.MiniAppUrl);
            var reloaded = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            using var subscription = options.OnChange(value => {
                if (value.MiniAppUrl == "https://new.example.test/") reloaded.TrySetResult();
            });
            await File.WriteAllTextAsync(file, """{"Telegram":{"MiniAppUrl":"https://new.example.test/"}}""");
            await reloaded.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal("https://new.example.test/", options.CurrentValue.MiniAppUrl);
            Assert.Equal("123456:test-only-secret", options.CurrentValue.BotToken);
            Assert.True(options.CurrentValue.Enabled);
        }
        finally { File.Delete(file); Directory.Delete(directory); }
    }

    private sealed class MutableOptions(TelegramOptions value) : IOptionsMonitor<TelegramOptions>
    {
        public TelegramOptions CurrentValue { get; set; } = value;
        public TelegramOptions Get(string? name) => CurrentValue;
        public IDisposable? OnChange(Action<TelegramOptions, string?> listener) => null;
    }

    private sealed class BotTransport(Action? afterFirstReply = null) : HttpMessageHandler
    {
        public TaskCompletionSource Acknowledged { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public ConcurrentQueue<long> RepliedChats { get; } = new();
        public ConcurrentQueue<string> ButtonUrls { get; } = new();
        public string? ButtonUrl { get; private set; }
        public string? ButtonText { get; private set; }
        public int RequestCount;
        private int polls;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref RequestCount);
            if (request.RequestUri!.AbsolutePath.EndsWith("/getUpdates", StringComparison.Ordinal))
            {
                if (Interlocked.Increment(ref polls) == 1) return Json(HttpStatusCode.OK, """
                    {"ok":true,"result":[
                      {"update_id":1,"message":{"message_id":1,"date":1792051200,"chat":{"id":111,"type":"private"},"text":"/start"}},
                      {"update_id":2,"message":{"message_id":2,"date":1792051200,"chat":{"id":222,"type":"private"},"text":"/start test"}},
                      {"update_id":3,"message":{"message_id":3,"date":1792051200,"chat":{"id":-333,"type":"group","title":"Group"},"text":"/start"}},
                      {"update_id":4,"message":{"message_id":4,"date":1792051200,"chat":{"id":444,"type":"private"},"text":"hello"}}
                    ]}
                    """);
                using var poll = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken));
                if (poll.RootElement.GetProperty("offset").GetInt32() == 5) Acknowledged.TrySetResult();
                else Acknowledged.TrySetException(new InvalidOperationException("Processed update offset was not acknowledged."));
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                throw new InvalidOperationException("Unreachable");
            }
            Assert.EndsWith("/sendMessage", request.RequestUri.AbsolutePath);
            using var document = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken));
            var root = document.RootElement;
            var chatId = root.GetProperty("chat_id").GetInt64();
            RepliedChats.Enqueue(chatId);
            var button = root.GetProperty("reply_markup").GetProperty("inline_keyboard")[0][0];
            ButtonUrl = button.GetProperty("web_app").GetProperty("url").GetString();
            ButtonUrls.Enqueue(ButtonUrl!);
            ButtonText = button.GetProperty("text").GetString();
            if (chatId == 111)
            {
                afterFirstReply?.Invoke();
                return Json(HttpStatusCode.Forbidden,
                    """{"ok":false,"error_code":403,"description":"Forbidden: sensitive-response-text test-only-secret"}""");
            }
            return Json(HttpStatusCode.OK,
                """{"ok":true,"result":{"message_id":10,"date":1792051200,"chat":{"id":222,"type":"private"},"text":"Welcome"}}""");
        }

        private static HttpResponseMessage Json(HttpStatusCode status, string content) => new(status)
        { Content = new StringContent(content, Encoding.UTF8, "application/json") };
    }

    private sealed class CapturedLogger : ILogger<TelegramBotWorker>
    {
        public ConcurrentQueue<string> Messages { get; } = new();
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
            Messages.Enqueue(formatter(state, exception));
    }
}
