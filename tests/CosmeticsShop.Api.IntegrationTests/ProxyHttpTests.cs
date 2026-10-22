using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using CosmeticsShop.Contracts.Admin;
using CosmeticsShop.Infrastructure.Auth;
using Microsoft.EntityFrameworkCore;

namespace CosmeticsShop.Api.IntegrationTests;

public sealed class ProxyHttpTests(PostgresFixture fixture) : IClassFixture<PostgresFixture>
{
    [Theory]
    [InlineData(null, 503)]
    [InlineData("192.0.2.10", 503)]
    [InlineData("127.0.0.1", 200)]
    public async Task OnlyExplicitlyTrustedProxyCanForwardHttps(string? proxy, int expected)
    {
        await using var app = TestShopHost.Create(fixture, "Production", proxy);
        await app.StartAsync();
        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("tma", TelegramValidationTests.Golden);
        client.DefaultRequestHeaders.Add("X-Forwarded-Proto", "https");
        using var response = await client.PostAsync("/api/auth/telegram", null);
        Assert.Equal((HttpStatusCode)expected, response.StatusCode);
        if (expected == 503)
        {
            var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("secure_transport_unavailable", problem.GetProperty("code").GetString());
        }
        await app.StopAsync();
    }

    [Fact]
    public async Task TransportFailurePreventsWriteAndProtectedRetryCreatesExactlyOneRecord()
    {
        await using var app = TestShopHost.Create(fixture, "Production", "127.0.0.1");
        await app.StartAsync();
        await using var db = fixture.CreateContext();
        await new UserAccess(db).GrantAdminAsync(9_000_000_001, default);
        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("tma", TelegramValidationTests.Golden);
        var body = new SaveBrandRequest("Без дублей", null);
        using var rejected = await client.PostAsJsonAsync("/api/admin/brands", body);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, rejected.StatusCode);
        Assert.Equal("secure_transport_unavailable", (await rejected.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
        Assert.Equal(0, await db.Brands.CountAsync());

        client.DefaultRequestHeaders.Add("X-Forwarded-Proto", "https");
        using var accepted = await client.PostAsJsonAsync("/api/admin/brands", body);
        Assert.Equal(HttpStatusCode.Created, accepted.StatusCode);
        Assert.Equal(1, await db.Brands.CountAsync());
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("tma", "invalid-test-data");
        using var invalid = await client.PostAsJsonAsync("/api/admin/brands", body);
        Assert.Equal(HttpStatusCode.Unauthorized, invalid.StatusCode);
        Assert.False((await invalid.Content.ReadFromJsonAsync<JsonElement>()).TryGetProperty("code", out _));
        Assert.Equal(1, await db.Brands.CountAsync());
        await app.StopAsync();
    }
}
