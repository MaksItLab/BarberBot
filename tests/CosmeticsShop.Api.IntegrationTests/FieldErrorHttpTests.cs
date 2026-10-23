using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using CosmeticsShop.Contracts.Admin;

namespace CosmeticsShop.Api.IntegrationTests;

/// <summary>U03: an invalid product field is named by its request path, so the form can mark it and keep the input.</summary>
public sealed class FieldErrorHttpTests(PostgresFixture fixture) : IClassFixture<PostgresFixture>
{
    [Fact]
    public async Task InvalidProductFieldIsReturnedAsValidationProblemWithItsPath()
    {
        await using var app = TestShopHost.Create(fixture); await app.StartAsync();
        var products = new AdminProductHttpTests(fixture);
        using var client = await products.AdminClient(app.Urls.Single());
        var input = await products.Input();
        var variant = input.Variants![0]!;
        var cases = new (SaveProductRequest Request, string Field)[] {
            (input with { Name = " " }, "name"),
            (input with { Description = new string('a', 12001) }, "description"),
            (input with { ImagePath = "https://example.com/a.png" }, "imagePath"),
            (input with { BrandId = "x" }, "brandId"),
            (input with { TypeId = "0" }, "typeId"),
            (input with { Variants = [variant, variant with { Volume = "100 мл", PriceRub = 0.001m }] }, "variants[1].priceRub"),
            (input with { Variants = [variant, variant with { Shade = new string('a', 121) }] }, "variants[1].shade"),
            (input with { Variants = [variant, null] }, "variants[1]"),
            (input with { Variants = [variant with { IsVisible = false }] }, "isVisible"),
        };
        foreach (var (request, field) in cases)
        {
            using var response = await client.PostAsJsonAsync("/api/admin/products", request);
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
            using var problem = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            var root = problem.RootElement;
            Assert.Equal("validation_failed", root.GetProperty("code").GetString());
            Assert.Matches("^[0-9a-f]{32}$", root.GetProperty("requestId").GetString());
            var errors = root.GetProperty("errors").EnumerateObject().ToArray();
            var error = Assert.Single(errors);
            Assert.Equal(field, error.Name);
            // The title repeats the message, so a client that does not read "errors" still shows it.
            Assert.Equal(root.GetProperty("title").GetString(), Assert.Single(error.Value.EnumerateArray()).GetString());
        }
        // A failure that is not about one field keeps the plain problem shape.
        using var stale = await client.PostAsJsonAsync("/api/admin/products", input with { BrandId = long.MaxValue.ToString() });
        Assert.Equal(HttpStatusCode.BadRequest, stale.StatusCode);
        using var plain = JsonDocument.Parse(await stale.Content.ReadAsStringAsync());
        Assert.False(plain.RootElement.TryGetProperty("errors", out _));
        await app.StopAsync();
    }
}
