using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using CosmeticsShop.Contracts.Admin;
using CosmeticsShop.Infrastructure.Auth;
using Microsoft.EntityFrameworkCore;

namespace CosmeticsShop.Api.IntegrationTests;

public sealed class IdempotentSaveHttpTests(PostgresFixture fixture) : IClassFixture<PostgresFixture>
{
    private readonly AdminProductHttpTests products = new(fixture);

    [Fact]
    public async Task RepeatedCreateAfterLostResponseReturnsTheSameProductAndWritesOnce()
    {
        await using var app = TestShopHost.Create(fixture); await app.StartAsync();
        using var client = await products.AdminClient(app.Urls.Single());
        var input = await products.Input() with { Name = "Повтор " + Guid.NewGuid().ToString("N") };
        var key = Guid.NewGuid();
        using var first = await Send(client, HttpMethod.Post, "/api/admin/products", input, key);
        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        Assert.False(first.Headers.Contains("Idempotent-Replayed"));
        var created = (await first.Content.ReadFromJsonAsync<AdminProduct>())!;
        // The client never saw the first response and sends the same intent again; extra spaces are not different data.
        using var repeat = await Send(client, HttpMethod.Post, "/api/admin/products", input with { Name = " " + input.Name + " " }, key);
        Assert.Equal(HttpStatusCode.Created, repeat.StatusCode);
        Assert.Equal("true", repeat.Headers.GetValues("Idempotent-Replayed").Single());
        Assert.Equal(created.Id, (await repeat.Content.ReadFromJsonAsync<AdminProduct>())!.Id);
        Assert.Equal(1, await Count(input.Name!));

        var operation = await client.GetFromJsonAsync<SaveOperationResponse>($"/api/admin/operations/{key}");
        Assert.Equal(new SaveOperationResponse("product.create", created.Id), operation);
        using var unknown = await client.GetAsync($"/api/admin/operations/{Guid.NewGuid()}");
        Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
        Assert.Equal("operation_not_found", (await unknown.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());

        // A new deliberate create gets a new key and is a new product.
        using var another = await Send(client, HttpMethod.Post, "/api/admin/products", input, Guid.NewGuid());
        Assert.Equal(HttpStatusCode.Created, another.StatusCode);
        Assert.Equal(2, await Count(input.Name!));
        await app.StopAsync();
    }

    [Fact]
    public async Task ConcurrentRequestsWithOneKeyCreateOneProduct()
    {
        await using var app = TestShopHost.Create(fixture); await app.StartAsync();
        using var client = await products.AdminClient(app.Urls.Single());
        var input = await products.Input() with { Name = "Параллельно " + Guid.NewGuid().ToString("N") };
        var key = Guid.NewGuid();
        var responses = await Task.WhenAll(Enumerable.Range(0, 5).Select(_ => Send(client, HttpMethod.Post, "/api/admin/products", input, key)));
        Assert.All(responses, response => Assert.Equal(HttpStatusCode.Created, response.StatusCode));
        var ids = await Task.WhenAll(responses.Select(async response => (await response.Content.ReadFromJsonAsync<AdminProduct>())!.Id));
        Assert.Single(ids.Distinct());
        Assert.Equal(4, responses.Count(response => response.Headers.Contains("Idempotent-Replayed")));
        foreach (var response in responses) response.Dispose();
        Assert.Equal(1, await Count(input.Name!));
        await app.StopAsync();
    }

    [Fact]
    public async Task RepeatedUpdateIsNotReportedAsConflictAndKeyCannotCarryOtherData()
    {
        await using var app = TestShopHost.Create(fixture); await app.StartAsync();
        using var client = await products.AdminClient(app.Urls.Single());
        using var created = await client.PostAsJsonAsync("/api/admin/products", await products.Input());
        var product = (await created.Content.ReadFromJsonAsync<AdminProduct>())!;
        var edit = AdminProductHttpTests.From(product) with { Name = "Правка один раз" };
        var key = Guid.NewGuid();
        using var first = await Send(client, HttpMethod.Put, $"/api/admin/products/{product.Id}", edit, key);
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        // Without the key this repeat would carry a stale version and get 409.
        using var repeat = await Send(client, HttpMethod.Put, $"/api/admin/products/{product.Id}", edit, key);
        Assert.Equal(HttpStatusCode.OK, repeat.StatusCode);
        Assert.Equal("Правка один раз", (await repeat.Content.ReadFromJsonAsync<AdminProduct>())!.Name);

        using var reused = await Send(client, HttpMethod.Put, $"/api/admin/products/{product.Id}", edit with { Name = "Другие данные" }, key);
        Assert.Equal((HttpStatusCode)422, reused.StatusCode);
        Assert.Equal("idempotency_key_reused", (await reused.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
        using var reusedForCreate = await Send(client, HttpMethod.Post, "/api/admin/products", edit with { Version = null }, key);
        Assert.Equal((HttpStatusCode)422, reusedForCreate.StatusCode);
        Assert.Equal("Правка один раз", (await client.GetFromJsonAsync<AdminProduct>($"/api/admin/products/{product.Id}"))!.Name);
        await app.StopAsync();
    }

    [Fact]
    public async Task KeyIsRequiredScopedToItsOwnerAndForgottenOnlyAfterFailedAttempts()
    {
        await using var app = TestShopHost.Create(fixture); await app.StartAsync();
        using var client = await products.AdminClient(app.Urls.Single());
        var input = await products.Input() with { Name = "Владелец " + Guid.NewGuid().ToString("N") };
        using var plain = new HttpClient { BaseAddress = client.BaseAddress };
        plain.DefaultRequestHeaders.Authorization = client.DefaultRequestHeaders.Authorization;
        using var missing = await plain.PostAsJsonAsync("/api/admin/products", input);
        Assert.Equal(HttpStatusCode.BadRequest, missing.StatusCode);
        Assert.Equal("idempotency_key_required", (await missing.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());

        var key = Guid.NewGuid();
        // A rejected attempt stores nothing, so the same key works once the data is corrected.
        using var invalid = await Send(client, HttpMethod.Post, "/api/admin/products", input with { Description = " " }, key);
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        using var corrected = await Send(client, HttpMethod.Post, "/api/admin/products", input, key);
        Assert.Equal(HttpStatusCode.Created, corrected.StatusCode);

        // Another admin with the same key neither sees the first result nor is blocked by it.
        await using (var db = fixture.CreateContext()) await new UserAccess(db).GrantAdminAsync(9_000_000_002, default);
        using var other = new HttpClient { BaseAddress = client.BaseAddress };
        other.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("tma", TelegramValidationTests.Sign(user: "{\"id\":9000000002}"));
        using var hidden = await other.GetAsync($"/api/admin/operations/{key}");
        Assert.Equal(HttpStatusCode.NotFound, hidden.StatusCode);
        using var own = await Send(other, HttpMethod.Post, "/api/admin/products", input, key);
        Assert.Equal(HttpStatusCode.Created, own.StatusCode);
        Assert.False(own.Headers.Contains("Idempotent-Replayed"));
        Assert.Equal(2, await Count(input.Name!));
        await app.StopAsync();
    }

    private static Task<HttpResponseMessage> Send(HttpClient client, HttpMethod method, string url, SaveProductRequest body, Guid key)
    {
        var request = new HttpRequestMessage(method, url) { Content = JsonContent.Create(body) };
        request.Headers.Add("Idempotency-Key", key.ToString());
        return client.SendAsync(request);
    }

    private async Task<int> Count(string name)
    {
        await using var db = fixture.CreateContext();
        return await db.Products.CountAsync(product => product.Name == name.Trim());
    }
}
