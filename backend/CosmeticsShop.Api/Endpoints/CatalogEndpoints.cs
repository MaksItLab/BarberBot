using System.Globalization;
using CosmeticsShop.Application.Catalog;

namespace CosmeticsShop.Api.Endpoints;

public static class CatalogEndpoints
{
    public static void MapCatalog(this WebApplication app)
    {
        var group = app.MapGroup("/api/catalog");
        group.MapGet("/products", async (HttpRequest request, ICatalogReader reader, CancellationToken ct) =>
        {
            if (!TryQuery(request.Query, out var query))
                return Results.Problem(statusCode: 400, title: "Некорректные фильтры или номер страницы.");
            return Results.Ok(await reader.GetProductsAsync(query!, ct));
        });
        group.MapGet("/brands", async (ICatalogReader reader, CancellationToken ct) => Results.Ok(await reader.GetBrandsAsync(ct)));
        group.MapGet("/types", async (ICatalogReader reader, CancellationToken ct) => Results.Ok(await reader.GetTypesAsync(ct)));
        group.MapGet("/products/{id}", async (string id, ICatalogReader reader, CancellationToken ct) =>
        {
            if (!long.TryParse(id, NumberStyles.None, CultureInfo.InvariantCulture, out var productId) || productId <= 0)
                return Results.Problem(statusCode: 400, title: "Некорректный идентификатор товара.");
            var product = await reader.GetProductAsync(productId, ct);
            return product is null
                ? Results.Problem(statusCode: 404, title: "Товар недоступен.")
                : Results.Ok(product);
        });
    }

    public static bool TryQuery(IQueryCollection values, out CatalogQuery? query)
    {
        query = null;
        if (!TryNumber(values, "brandId", null, out var brandId)
            || !TryNumber(values, "typeId", null, out var typeId)
            || !TryNumber(values, "page", 1, out var page)
            || !TryNumber(values, "pageSize", 20, out var pageSize)
            || page > int.MaxValue || pageSize > int.MaxValue) return false;
        query = new CatalogQuery(brandId, typeId, (int)page!.Value, (int)pageSize!.Value);
        return query.IsValid;
    }

    private static bool TryNumber(IQueryCollection values, string key, long? fallback, out long? result)
    {
        result = fallback;
        if (!values.TryGetValue(key, out var value)) return true;
        if (value.Count != 1 || !long.TryParse(value[0], NumberStyles.None, CultureInfo.InvariantCulture, out var number)
            || number <= 0) return false;
        result = number;
        return true;
    }
}
