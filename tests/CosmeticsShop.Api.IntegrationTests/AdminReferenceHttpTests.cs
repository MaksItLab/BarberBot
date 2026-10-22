using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using CosmeticsShop.Contracts.Admin;
using CosmeticsShop.Contracts.Catalog;
using CosmeticsShop.Domain;
using CosmeticsShop.Infrastructure.Auth;
using Microsoft.EntityFrameworkCore;

namespace CosmeticsShop.Api.IntegrationTests;

public sealed class AdminReferenceHttpTests(PostgresFixture fixture) : IClassFixture<PostgresFixture>
{
    [Fact]
    public async Task AdminCreatesEditsAndValidatesReferencesWhileCustomerCannotWrite()
    {
        await using var app = TestShopHost.Create(fixture);
        await app.StartAsync();
        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };
        foreach (var path in new[] { "brands", "types" })
        {
            using var anonymous = await client.PostAsJsonAsync($"/api/admin/{path}", new { name = "Запрет" });
            Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);
        }
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("tma", TelegramValidationTests.Golden);
        using var register = await client.PostAsync("/api/auth/telegram", null);
        foreach (var path in new[] { "brands", "types" })
        {
            using var denied = await client.PutAsJsonAsync($"/api/admin/{path}/1", new { name = "Запрет" });
            Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        }
        await using var db = fixture.CreateContext();
        await new UserAccess(db).GrantAdminAsync(9_000_000_001, default);
        using var createdBrand = await client.PostAsJsonAsync("/api/admin/brands", new SaveBrandRequest("  Бренд  ", "  Описание  "));
        Assert.Equal(HttpStatusCode.Created, createdBrand.StatusCode);
        var brand = (await createdBrand.Content.ReadFromJsonAsync<BrandResponse>())!;
        Assert.Equal("Бренд", brand.Name); Assert.Equal("Описание", brand.Description);
        using var createdType = await client.PostAsJsonAsync("/api/admin/types", new SaveTypeRequest(" Уход "));
        Assert.Equal(HttpStatusCode.Created, createdType.StatusCode);
        var type = (await createdType.Content.ReadFromJsonAsync<TypeResponse>())!;
        foreach (var path in new[] { "brands", "types" })
        {
            foreach (var name in new[] { "   ", new string('a', path == "brands" ? 161 : 101) })
            {
                using var invalid = await client.PostAsJsonAsync($"/api/admin/{path}", new { name });
                Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
                Assert.Equal("application/problem+json", invalid.Content.Headers.ContentType?.MediaType);
            }
            using var missing = await client.PutAsJsonAsync($"/api/admin/{path}/9223372036854775807", new { name = "Не найден" });
            Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        }
        using var duplicate = await client.PostAsJsonAsync("/api/admin/brands", new SaveBrandRequest(" Бренд ", null));
        Assert.Equal(HttpStatusCode.Conflict, duplicate.StatusCode);
        using var longDescription = await client.PostAsJsonAsync("/api/admin/brands", new SaveBrandRequest("Длинный", new string('a', 4001)));
        Assert.Equal(HttpStatusCode.BadRequest, longDescription.StatusCode);
        db.Products.Add(new Product { Name = "Крем", Description = "Описание", IsVisible = true,
            BrandId = long.Parse(brand.Id), CosmeticTypeId = long.Parse(type.Id), Variants = [new ProductVariant { PriceRub = 100 }] });
        await db.SaveChangesAsync();
        using var renamed = await client.PutAsJsonAsync($"/api/admin/brands/{brand.Id}", new SaveBrandRequest("Новое имя", null));
        Assert.Equal(HttpStatusCode.OK, renamed.StatusCode);
        var catalog = await client.GetFromJsonAsync<ProductPage>("/api/catalog/products");
        Assert.Equal("Новое имя", Assert.Single(catalog!.Items).BrandName);
        using var renameType = await client.PutAsJsonAsync($"/api/admin/types/{type.Id}", new SaveTypeRequest("Новый тип"));
        Assert.Equal(HttpStatusCode.OK, renameType.StatusCode);
        Assert.Equal("Новое имя", Assert.Single((await client.GetFromJsonAsync<BrandResponse[]>("/api/admin/brands"))!).Name);
        Assert.Equal("Новый тип", Assert.Single((await client.GetFromJsonAsync<TypeResponse[]>("/api/admin/types"))!).Name);
        await app.StopAsync();
    }
}
