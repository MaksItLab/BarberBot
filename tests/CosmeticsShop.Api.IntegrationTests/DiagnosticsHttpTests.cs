using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using CosmeticsShop.Contracts.Admin;
using CosmeticsShop.Infrastructure.Auth;
using CosmeticsShop.Infrastructure.Data;
using Microsoft.AspNetCore.Builder;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace CosmeticsShop.Api.IntegrationTests;

public sealed class DiagnosticsHttpTests(PostgresFixture fixture) : IClassFixture<PostgresFixture>
{
    [Fact]
    public async Task EveryFailureClassHasStableCodeAndRequestIdMatchingHeader()
    {
        await using var db = fixture.CreateContext();
        await new UserAccess(db).GrantAdminAsync(9_000_000_001, default);
        await using var app = TestShopHost.Create(fixture);
        await app.StartAsync();
        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };

        await AssertProblem(client, HttpMethod.Post, "/api/auth/telegram", null, HttpStatusCode.Unauthorized, "auth_missing");
        await AssertProblem(client, HttpMethod.Post, "/api/auth/telegram", TelegramValidationTests.Golden.Replace("test-query", "forged"),
            HttpStatusCode.Unauthorized, "auth_invalid");
        await AssertProblem(client, HttpMethod.Post, "/api/auth/telegram", TelegramValidationTests.Sign(TelegramValidationTests.Now - 3601),
            HttpStatusCode.Unauthorized, "auth_expired");
        await AssertProblem(client, HttpMethod.Get, "/api/admin/brands", TelegramValidationTests.Sign(user: "{\"id\":42}"),
            HttpStatusCode.Forbidden, "forbidden");
        await AssertProblem(client, HttpMethod.Post, "/api/admin/brands", TelegramValidationTests.Golden,
            HttpStatusCode.BadRequest, "validation_failed", new SaveBrandRequest("", null));
        await AssertProblem(client, HttpMethod.Get, "/api/admin/products/999999", TelegramValidationTests.Golden,
            HttpStatusCode.NotFound, "not_found");
        await app.StopAsync();
    }

    [Fact]
    public async Task UnreachableDatabaseIsReportedSeparatelyFromMissingRights()
    {
        var logs = new CapturingLoggerProvider();
        await using var app = TestShopHost.Create(fixture, configure: builder =>
        {
            builder.Services.AddScoped(_ => new ShopDbContext(new DbContextOptionsBuilder<ShopDbContext>()
                .UseNpgsql("Host=127.0.0.1;Port=1;Database=none;Username=none;Password=none;Timeout=2").Options));
            builder.Logging.AddProvider(logs);
        });
        await app.StartAsync();
        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };
        // Login is safe to repeat; an admin write may have been applied, so the admin is asked to check first.
        var login = await AssertProblem(client, HttpMethod.Post, "/api/auth/telegram", TelegramValidationTests.Golden,
            HttpStatusCode.ServiceUnavailable, "database_unavailable");
        Assert.Contains("Повторите попытку позже", login.GetProperty("title").GetString());
        var save = await AssertProblem(client, HttpMethod.Post, "/api/admin/brands", TelegramValidationTests.Golden,
            HttpStatusCode.ServiceUnavailable, "database_unavailable", new SaveBrandRequest("Бренд", null));
        Assert.Contains("сохранились", save.GetProperty("title").GetString());
        await app.StopAsync();
        // The exception handler re-executes the pipeline without an endpoint; the log keeps the original route.
        Assert.Contains(logs.Messages, line => line.StartsWith("operation=login method=POST route=/api/auth/telegram status=503 code=database_unavailable",
            StringComparison.Ordinal));
    }

    [Fact]
    public async Task LogLineHasOutcomeAndTimingsButNoTelegramDataOrIdentifiers()
    {
        var logs = new CapturingLoggerProvider();
        await using var db = fixture.CreateContext();
        await new UserAccess(db).GrantAdminAsync(9_000_000_001, default);
        await using var app = TestShopHost.Create(fixture, configure: builder =>
        {
            builder.Logging.ClearProviders();
            builder.Logging.SetMinimumLevel(LogLevel.Trace);
            builder.Logging.AddProvider(logs);
        });
        await app.StartAsync();
        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("tma", TelegramValidationTests.Golden);
        using var login = await client.PostAsync("/api/auth/telegram", null);
        using var save = await client.PostAsJsonAsync("/api/admin/brands", new SaveBrandRequest("Журнал", null));
        Assert.Equal(HttpStatusCode.Created, save.StatusCode);
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("tma", TelegramValidationTests.Golden.Replace("test-query", "forged"));
        using var forged = await client.PostAsync("/api/auth/telegram", null);
        await app.StopAsync();

        var requestLines = logs.Messages.Where(line => line.StartsWith("operation=", StringComparison.Ordinal)).ToArray();
        var loginId = login.Headers.GetValues("X-Request-Id").Single();
        Assert.Contains(requestLines, line => line.Contains("operation=login") && line.Contains("status=200") && line.Contains("code=ok")
            && line.Contains($"request={loginId}") && !line.Contains("auth_ms= "));
        Assert.Contains(requestLines, line => line.Contains("operation=save") && line.Contains("route=/api/admin/brands") && line.Contains("status=201"));
        Assert.Contains(requestLines, line => line.Contains("operation=login") && line.Contains("code=auth_invalid"));
        var all = string.Join('\n', logs.Messages);
        Assert.DoesNotContain("query_id", all);
        Assert.DoesNotContain("2a720b9be302b994", all);
        Assert.DoesNotContain("9000000001", all);
        Assert.DoesNotContain("tma ", all);
    }

    private static async Task<JsonElement> AssertProblem(HttpClient client, HttpMethod method, string url, string? initData,
        HttpStatusCode expectedStatus, string expectedCode, object? body = null)
    {
        using var request = new HttpRequestMessage(method, url);
        if (initData is not null) request.Headers.Authorization = new AuthenticationHeaderValue("tma", initData);
        if (body is not null) request.Content = JsonContent.Create(body);
        using var response = await client.SendAsync(request);
        Assert.Equal(expectedStatus, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(expectedCode, problem.GetProperty("code").GetString());
        var requestId = response.Headers.GetValues("X-Request-Id").Single();
        Assert.Matches("^[0-9a-f]{32}$", requestId);
        Assert.Equal(requestId, problem.GetProperty("requestId").GetString());
        Assert.Contains(requestId, problem.GetProperty("traceId").GetString());
        return problem.Clone();
    }

    private sealed class CapturingLoggerProvider : ILoggerProvider
    {
        public ConcurrentQueue<string> Messages { get; } = new();
        public ILogger CreateLogger(string categoryName) => new Logger(Messages);
        public void Dispose() { }

        private sealed class Logger(ConcurrentQueue<string> messages) : ILogger
        {
            public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
            public bool IsEnabled(LogLevel logLevel) => true;
            public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
                messages.Enqueue(formatter(state, exception) + (exception is null ? "" : "\n" + exception));
        }
    }
}
