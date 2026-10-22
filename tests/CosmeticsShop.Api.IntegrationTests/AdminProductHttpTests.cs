using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using CosmeticsShop.Contracts.Admin;
using CosmeticsShop.Contracts.Catalog;
using CosmeticsShop.Domain;
using CosmeticsShop.Infrastructure.Auth;
using Microsoft.EntityFrameworkCore;

namespace CosmeticsShop.Api.IntegrationTests;

public sealed class AdminProductHttpTests(PostgresFixture fixture) : IClassFixture<PostgresFixture>
{
    [Fact]
    public async Task DraftPublicationVariantsAndSwappedOptionsStayConsistentWithPublicCatalog()
    {
        await using var app = TestShopHost.Create(fixture); await app.StartAsync();
        using var client = await AdminClient(app.Urls.Single());
        var input = await Input();
        var draft = await Create(client, input with { IsVisible = false, Variants = [] });
        Assert.Empty((await client.GetFromJsonAsync<ProductPage>($"/api/catalog/products?brandId={draft.BrandId}"))!.Items);
        var invalid = await client.PutAsJsonAsync($"/api/admin/products/{draft.Id}", From(draft) with { IsVisible = true });
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        var published = await Update(client, draft.Id, From(draft) with { IsVisible = true, Variants = [
            new(null, " 50 мл ", " ", null, 100.19m, true), new(null, "100 мл", null, null, 200.99m, true)] });
        Assert.NotEqual(draft.Version, published.Version);
        Assert.Null(published.Variants[0].Size);
        var summary = Assert.Single((await client.GetFromJsonAsync<ProductPage>($"/api/catalog/products?brandId={draft.BrandId}"))!.Items);
        Assert.Equal(100.19m, summary.PriceRub); Assert.True(summary.HasPriceRange);
        var variants = From(published).Variants!;
        var swapped = await Update(client, published.Id, From(published) with { Variants = [
            variants[0]! with { Volume = "100 мл" }, variants[1]! with { Volume = "50 мл" }] });
        Assert.Equal("100 мл", swapped.Variants[0].Volume);
        var hiddenVariant = await Update(client, swapped.Id, From(swapped) with { Variants = [
            From(swapped).Variants![0]! with { IsVisible = false }, From(swapped).Variants![1] ] });
        summary = Assert.Single((await client.GetFromJsonAsync<ProductPage>($"/api/catalog/products?brandId={draft.BrandId}"))!.Items);
        Assert.Equal(200.99m, summary.PriceRub); Assert.False(summary.HasPriceRange);
        await Update(client, hiddenVariant.Id, From(hiddenVariant) with { IsVisible = false });
        using var unavailable = await client.GetAsync($"/api/catalog/products/{draft.Id}");
        Assert.Equal(HttpStatusCode.NotFound, unavailable.StatusCode);
        var adminPage = await client.GetFromJsonAsync<AdminProductPage>($"/api/admin/products?brandId={draft.BrandId}&pageSize=1");
        Assert.False(Assert.Single(adminPage!.Items).IsVisible);
        await app.StopAsync();
    }

    [Fact]
    public async Task InvalidFieldsPricesLinksAndDuplicateOptionsDoNotChangeAggregate()
    {
        await using var app = TestShopHost.Create(fixture); await app.StartAsync();
        using var client = await AdminClient(app.Urls.Single());
        var product = await Create(client, await Input());
        var original = From(product);
        var variant = original.Variants![0]!;
        var invalids = new[] {
            original with { Name = " " }, original with { Description = " " },
            original with { BrandId = long.MaxValue.ToString() }, original with { TypeId = "0" },
            original with { ImagePath = "https://example.com/a.png" }, original with { ImagePath = "/images/../secret.png" },
            original with { Variants = [variant with { PriceRub = null }] }, original with { Variants = [variant with { PriceRub = -0.01m }] },
            original with { Variants = [variant with { PriceRub = 0.001m }] }, original with { Variants = [variant with { PriceRub = 10_000_000_000m }] },
            original with { Variants = [variant with { IsVisible = false }] }, original with { Variants = [null] },
            original with { Variants = Enumerable.Repeat<SaveVariantRequest?>(variant, 101).ToArray() }, original with { Version = "bad" }
        };
        foreach (var request in invalids)
        {
            using var response = await client.PutAsJsonAsync($"/api/admin/products/{product.Id}", request);
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        }
        using var duplicate = await client.PutAsJsonAsync($"/api/admin/products/{product.Id}", original with { Variants = [variant, variant with { Id = null, Volume = " " }] });
        Assert.Equal(HttpStatusCode.Conflict, duplicate.StatusCode);
        var current = (await client.GetFromJsonAsync<AdminProduct>($"/api/admin/products/{product.Id}"))!;
        Assert.Equal(product.Version, current.Version); Assert.Equal(product.Name, current.Name); Assert.Single(current.Variants);
        // Both inclusive monetary limits are accepted, without rounding.
        var zero = await Update(client, current.Id, From(current) with { Variants = [From(current).Variants![0]! with { PriceRub = 0 }] });
        var maximum = await Update(client, zero.Id, From(zero) with { Variants = [From(zero).Variants![0]! with { PriceRub = 9_999_999_999.99m }] });
        Assert.Equal(9_999_999_999.99m, maximum.Variants.Single().PriceRub);
        await app.StopAsync();
    }

    [Fact]
    public async Task ForeignVariantOmissionStaleVersionAndConcurrentWritesCannotOverwriteAnotherEdit()
    {
        await using var app = TestShopHost.Create(fixture); await app.StartAsync();
        using var client = await AdminClient(app.Urls.Single());
        var first = await Create(client, await Input());
        var second = await Create(client, await Input());
        using var foreign = await client.PutAsJsonAsync($"/api/admin/products/{first.Id}", From(first) with { Variants = [From(second).Variants![0]] });
        Assert.Equal(HttpStatusCode.BadRequest, foreign.StatusCode);
        using var omitted = await client.PutAsJsonAsync($"/api/admin/products/{first.Id}", From(first) with { IsVisible = false, Variants = [] });
        Assert.Equal(HttpStatusCode.BadRequest, omitted.StatusCode);
        var left = From(first) with { Name = "Правка А", Variants = [From(first).Variants![0]! with { PriceRub = 111 }] };
        var right = From(first) with { Name = "Правка Б", Variants = [From(first).Variants![0]! with { PriceRub = 222 }] };
        var responses = await Task.WhenAll(client.PutAsJsonAsync($"/api/admin/products/{first.Id}", left), client.PutAsJsonAsync($"/api/admin/products/{first.Id}", right));
        Assert.Single(responses, response => response.StatusCode == HttpStatusCode.OK);
        Assert.Single(responses, response => response.StatusCode == HttpStatusCode.Conflict);
        foreach (var response in responses) response.Dispose();
        var current = (await client.GetFromJsonAsync<AdminProduct>($"/api/admin/products/{first.Id}"))!;
        Assert.Equal(current.Name == "Правка А" ? 111m : 222m, current.Variants.Single().PriceRub);
        using var stale = await client.PutAsJsonAsync($"/api/admin/products/{first.Id}", From(first));
        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
        client.DefaultRequestHeaders.Authorization = null;
        using var anonymous = await client.PostAsJsonAsync("/api/admin/products", await Input());
        Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("tma", TelegramValidationTests.Sign(user: "{\"id\":123456789}"));
        using var customer = await client.PutAsJsonAsync($"/api/admin/products/{first.Id}", From(current));
        Assert.Equal(HttpStatusCode.Forbidden, customer.StatusCode);
        await app.StopAsync();
    }

    [Fact]
    public async Task FailureAfterTemporaryOptionSaveRollsBackParentAndAllVariants()
    {
        await using var app = TestShopHost.Create(fixture); await app.StartAsync();
        using var client = await AdminClient(app.Urls.Single());
        var product = await Create(client, await Input());
        await using var db = fixture.CreateContext();
        await db.Database.ExecuteSqlRawAsync("""
            CREATE FUNCTION reject_test_price() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN IF NEW.price_rub = 777 THEN RAISE EXCEPTION 'test-only failure'; END IF; RETURN NEW; END; $$;
            CREATE TRIGGER test_price BEFORE UPDATE ON product_variants FOR EACH ROW EXECUTE FUNCTION reject_test_price();
            """);
        try
        {
            using var failed = await client.PutAsJsonAsync($"/api/admin/products/{product.Id}", From(product) with {
                Name = "Не должно сохраниться", Variants = [From(product).Variants![0]! with { Volume = "100 мл", PriceRub = 777 }] });
            Assert.Equal(HttpStatusCode.InternalServerError, failed.StatusCode);
            var current = (await client.GetFromJsonAsync<AdminProduct>($"/api/admin/products/{product.Id}"))!;
            Assert.Equal(product.Name, current.Name); Assert.Equal(product.Version, current.Version);
            Assert.Null(current.Variants.Single().Volume); Assert.Equal(100.19m, current.Variants.Single().PriceRub);
        }
        finally { await db.Database.ExecuteSqlRawAsync("DROP TRIGGER test_price ON product_variants; DROP FUNCTION reject_test_price();"); }
        await app.StopAsync();
    }

    private async Task<HttpClient> AdminClient(string address)
    {
        await using var db = fixture.CreateContext(); await new UserAccess(db).GrantAdminAsync(9_000_000_001, default);
        var client = new HttpClient { BaseAddress = new Uri(address) };
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("tma", TelegramValidationTests.Golden);
        return client;
    }
    private async Task<SaveProductRequest> Input()
    {
        await using var db = fixture.CreateContext();
        var brand = new Brand { Name = Guid.NewGuid().ToString("N") };
        var type = new CosmeticType { Name = Guid.NewGuid().ToString("N") };
        db.AddRange(brand, type); await db.SaveChangesAsync();
        return new("Крем", "Описание", brand.Id.ToString(), type.Id.ToString(), null, true, null, [new(null, null, null, null, 100.19m, true)]);
    }
    private static SaveProductRequest From(AdminProduct product) => new(product.Name, product.Description, product.BrandId,
        product.TypeId, product.ImagePath, product.IsVisible, product.Version, product.Variants.Select(variant => (SaveVariantRequest?)new(variant.Id,
            variant.Volume, variant.Size, variant.Shade, variant.PriceRub, variant.IsVisible)).ToArray());
    private static async Task<AdminProduct> Create(HttpClient client, SaveProductRequest input)
    {
        using var response = await client.PostAsJsonAsync("/api/admin/products", input);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<AdminProduct>())!;
    }
    private static async Task<AdminProduct> Update(HttpClient client, string id, SaveProductRequest input)
    {
        using var response = await client.PutAsJsonAsync($"/api/admin/products/{id}", input);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<AdminProduct>())!;
    }
}
