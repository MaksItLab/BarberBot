using CosmeticsShop.Application.Admin;
using CosmeticsShop.Contracts.Admin;

namespace CosmeticsShop.Api.Endpoints;

public static class AdminProductEndpoints
{
    public static void MapAdminProducts(this WebApplication app)
    {
        var group = app.MapGroup("/api/admin/products").RequireAuthorization("Admin");
        group.MapGet("/", async (HttpRequest request, IAdminProducts products, CancellationToken ct) =>
            CatalogEndpoints.TryQuery(request.Query, out var query)
                ? Results.Ok(await products.GetProductsAsync(query!, ct))
                : Results.Problem(statusCode: 400, title: "Некорректная страница."));
        group.MapGet("/{id:long}", async (long id, IAdminProducts products, CancellationToken ct) => Results.Ok(await products.GetProductAsync(id, ct)));
        group.MapPost("/", async (SaveProductRequest request, IAdminProducts products, CancellationToken ct) =>
        {
            var product = await products.SaveAsync(null, request, ct);
            return Results.Created($"/api/admin/products/{product.Id}", product);
        });
        group.MapPut("/{id:long}", async (long id, SaveProductRequest request, IAdminProducts products, CancellationToken ct) => Results.Ok(await products.SaveAsync(id, request, ct)));
    }
}
