using System.Net;

namespace CosmeticsShop.Api.IntegrationTests;

/// <summary>U01: answers that depend on the Telegram user are never stored by a browser, tunnel or proxy cache.</summary>
public sealed class CacheHeaderHttpTests(PostgresFixture fixture) : IClassFixture<PostgresFixture>
{
    [Fact]
    public async Task AdminAndLoginAnswersAreNoStoreIncludingErrorsAndCatalogIsNotMarkedPublic()
    {
        await using var app = TestShopHost.Create(fixture); await app.StartAsync();
        using var admin = await new AdminProductHttpTests(fixture).AdminClient(app.Urls.Single());
        using var anonymous = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };

        var privateAnswers = new (HttpClient Client, HttpMethod Method, string Url, HttpStatusCode Status)[]
        {
            (admin, HttpMethod.Get, "/api/admin/products", HttpStatusCode.OK),
            (admin, HttpMethod.Get, "/api/admin/brands", HttpStatusCode.OK),
            (admin, HttpMethod.Get, "/api/admin/products/9223372036854775807", HttpStatusCode.NotFound),
            (admin, HttpMethod.Post, "/api/auth/telegram", HttpStatusCode.OK),
            (anonymous, HttpMethod.Get, "/api/admin/products", HttpStatusCode.Unauthorized),
            (anonymous, HttpMethod.Post, "/api/auth/telegram", HttpStatusCode.Unauthorized),
        };
        foreach (var (client, method, url, status) in privateAnswers)
        {
            using var response = await client.SendAsync(new HttpRequestMessage(method, url));
            Assert.Equal(status, response.StatusCode);
            Assert.True(response.Headers.CacheControl?.NoStore, $"{method} {url} must be no-store");
        }
        foreach (var url in new[] { "/api/catalog/products", "/api/catalog/brands", "/api/catalog/types" })
        {
            using var response = await anonymous.GetAsync(url);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.False(response.Headers.CacheControl?.Public ?? false, $"{url} is not shared-cacheable");
            Assert.False(response.Headers.CacheControl?.NoStore ?? false, $"{url} keeps default caching");
        }
        await app.StopAsync();
    }
}
