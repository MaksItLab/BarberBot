using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using CosmeticsShop.Contracts.Admin;
using Microsoft.EntityFrameworkCore;

namespace CosmeticsShop.Api.IntegrationTests;

public sealed class SaveIntegrityHttpTests(PostgresFixture fixture) : IClassFixture<PostgresFixture>
{
    private readonly AdminProductHttpTests products = new(fixture);
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    [Fact]
    public async Task FailureBeforeCommitLeavesNoProductChangeAndNoUsedKey()
    {
        await using var app = TestShopHost.Create(fixture); await app.StartAsync();
        using var client = await products.AdminClient(app.Urls.Single());
        using var created = await client.PostAsJsonAsync("/api/admin/products", await products.Input());
        var product = (await created.Content.ReadFromJsonAsync<AdminProduct>())!;
        var edit = AdminProductHttpTests.From(product) with { Name = "После сбоя", Variants = [AdminProductHttpTests.From(product).Variants![0]! with { PriceRub = 778 }] };
        var key = Guid.NewGuid();
        await using var db = fixture.CreateContext();
        await db.Database.ExecuteSqlRawAsync("""
            CREATE FUNCTION reject_integrity_price() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN IF NEW.price_rub = 778 THEN RAISE EXCEPTION 'test-only failure'; END IF; RETURN NEW; END; $$;
            CREATE TRIGGER integrity_price BEFORE UPDATE ON product_variants FOR EACH ROW EXECUTE FUNCTION reject_integrity_price();
            """);
        try
        {
            using var failed = await Send(client, HttpMethod.Put, $"/api/admin/products/{product.Id}", edit, key);
            Assert.Equal(HttpStatusCode.InternalServerError, failed.StatusCode);
            var current = (await client.GetFromJsonAsync<AdminProduct>($"/api/admin/products/{product.Id}"))!;
            Assert.Equal(product.Name, current.Name); Assert.Equal(product.Version, current.Version);
            Assert.Equal(product.Variants.Single().PriceRub, current.Variants.Single().PriceRub);
            // The operation row was in the same transaction: the interface correctly learns "not saved".
            using var outcome = await client.GetAsync($"/api/admin/operations/{key}");
            Assert.Equal(HttpStatusCode.NotFound, outcome.StatusCode);
        }
        finally { await db.Database.ExecuteSqlRawAsync("DROP TRIGGER integrity_price ON product_variants; DROP FUNCTION reject_integrity_price();"); }
        using var retried = await Send(client, HttpMethod.Put, $"/api/admin/products/{product.Id}", edit, key);
        Assert.Equal(HttpStatusCode.OK, retried.StatusCode);
        Assert.False(retried.Headers.Contains("Idempotent-Replayed"));
        await app.StopAsync();
    }

    [Fact]
    public async Task ConfirmedSaveIsVisibleToIndependentReadAfterRestart()
    {
        AdminProduct saved;
        await using (var first = TestShopHost.Create(fixture))
        {
            await first.StartAsync();
            using var client = await products.AdminClient(first.Urls.Single());
            using var response = await client.PostAsJsonAsync("/api/admin/products", await products.Input() with {
                Variants = [new(null, "50 мл", null, null, 10.5m, true), new(null, "100 мл", null, null, 20m, false)] });
            Assert.Equal(HttpStatusCode.Created, response.StatusCode);
            saved = (await response.Content.ReadFromJsonAsync<AdminProduct>())!;
            await first.StopAsync();
        }
        await using var second = TestShopHost.Create(fixture); await second.StartAsync();
        using var reader = await products.AdminClient(second.Urls.Single());
        var reread = (await reader.GetFromJsonAsync<AdminProduct>($"/api/admin/products/{saved.Id}"))!;
        Assert.Equal(saved with { Variants = [] }, reread with { Variants = [] });
        // Decimal equality ignores scale: 10.5 sent and 10.50 read back from numeric(12,2) are the same price.
        Assert.Equal(saved.Variants, reread.Variants);
        await using var db = fixture.CreateContext();
        Assert.Equal(2, await db.ProductVariants.CountAsync(variant => variant.ProductId == long.Parse(saved.Id)));
        await second.StopAsync();
    }

    [Fact]
    public async Task StaleEditIsRejectedWithTheCurrentVersionAndOverwritesNothing()
    {
        await using var app = TestShopHost.Create(fixture); await app.StartAsync();
        using var client = await products.AdminClient(app.Urls.Single());
        using var created = await client.PostAsJsonAsync("/api/admin/products", await products.Input());
        var original = (await created.Content.ReadFromJsonAsync<AdminProduct>())!;
        using var theirs = await client.PutAsJsonAsync($"/api/admin/products/{original.Id}", AdminProductHttpTests.From(original) with { Name = "Правка коллеги" });
        var current = (await theirs.Content.ReadFromJsonAsync<AdminProduct>())!;

        var key = Guid.NewGuid();
        var mine = AdminProductHttpTests.From(original) with { Description = "Моё описание" };
        using var stale = await Send(client, HttpMethod.Put, $"/api/admin/products/{original.Id}", mine, key);
        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
        var problem = await stale.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("conflict", problem.GetProperty("code").GetString());
        var reported = problem.GetProperty("current").Deserialize<AdminProduct>(Web)!;
        Assert.Equal(current.Version, reported.Version); Assert.Equal("Правка коллеги", reported.Name);
        Assert.Equal("Правка коллеги", (await client.GetFromJsonAsync<AdminProduct>($"/api/admin/products/{original.Id}"))!.Name);

        // After an explicit choice the same form applies its change on top of the new version, with the same key.
        using var applied = await Send(client, HttpMethod.Put, $"/api/admin/products/{original.Id}", mine with { Name = reported.Name, Version = reported.Version }, key);
        Assert.Equal(HttpStatusCode.OK, applied.StatusCode);
        var result = (await applied.Content.ReadFromJsonAsync<AdminProduct>())!;
        Assert.Equal("Правка коллеги", result.Name); Assert.Equal("Моё описание", result.Description);
        await app.StopAsync();
    }

    private static Task<HttpResponseMessage> Send(HttpClient client, HttpMethod method, string url, SaveProductRequest body, Guid key)
    {
        var request = new HttpRequestMessage(method, url) { Content = JsonContent.Create(body) };
        request.Headers.Add("Idempotency-Key", key.ToString());
        return client.SendAsync(request);
    }
}
