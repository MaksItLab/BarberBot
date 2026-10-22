using System.Net;
using CosmeticsShop.Api.Endpoints;
using CosmeticsShop.Application.Catalog;
using CosmeticsShop.Infrastructure.Catalog;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;

namespace CosmeticsShop.Api.IntegrationTests;

public sealed class CatalogHttpTests(PostgresFixture fixture) : IClassFixture<PostgresFixture>
{
    [Fact]
    public async Task PublicRoutesReturnJsonAndRejectInvalidOrAmbiguousQueryWithProblemDetails()
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Services.AddScoped(_ => fixture.CreateContext());
        builder.Services.AddScoped<ICatalogReader, CatalogReader>();
        await using var app = builder.Build();
        app.MapCatalog();
        await app.StartAsync();
        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };
        foreach (var path in new[] { "/brands", "/types", "/products", "/products?brandId=9223372036854775807" })
        {
            using var response = await client.GetAsync("/api/catalog" + path);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);
        }
        foreach (var query in new[] { "page=0", "page=-1", "page=hello", "pageSize=61", "pageSize=0", "brandId=", "typeId=-1", "page=2147483647", "page=1&page=2", "brandId=9223372036854775808" })
        {
            using var response = await client.GetAsync("/api/catalog/products?" + query);
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        }
        using var missing = await client.GetAsync("/api/catalog/products/9223372036854775807");
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        Assert.Equal("application/problem+json", missing.Content.Headers.ContentType?.MediaType);
        using var invalid = await client.GetAsync("/api/catalog/products/hello");
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        await app.StopAsync();
    }
}
