using System.Globalization;
using System.Security.Claims;
using CosmeticsShop.Api.Hosting;
using CosmeticsShop.Application.Admin;
using CosmeticsShop.Contracts.Admin;

namespace CosmeticsShop.Api.Endpoints;

public static class AdminProductEndpoints
{
    public const string IdempotencyKeyHeader = "Idempotency-Key";
    public const string ReplayedHeader = "Idempotent-Replayed";

    public static void MapAdminProducts(this WebApplication app)
    {
        var group = app.MapGroup("/api/admin/products").RequireAuthorization("Admin");
        group.MapGet("/", async (HttpRequest request, IAdminProducts products, CancellationToken ct) =>
            CatalogEndpoints.TryQuery(request.Query, out var query)
                ? Results.Ok(await products.GetProductsAsync(query!, ct))
                : Results.Problem(statusCode: 400, title: "Некорректная страница."));
        group.MapGet("/{id:long}", async (long id, IAdminProducts products, CancellationToken ct) => Results.Ok(await products.GetProductAsync(id, ct)));
        group.MapPost("/", async (HttpContext context, SaveProductRequest request, IAdminProducts products, CancellationToken ct) =>
        {
            if (Intent(context) is not { } intent) return MissingKey();
            var result = await products.SaveAsync(null, request, intent, ct);
            MarkReplay(context, result);
            return Results.Created($"/api/admin/products/{result.Product.Id}", result.Product);
        });
        group.MapPut("/{id:long}", async (HttpContext context, long id, SaveProductRequest request, IAdminProducts products, CancellationToken ct) =>
        {
            if (Intent(context) is not { } intent) return MissingKey();
            var result = await products.SaveAsync(id, request, intent, ct);
            MarkReplay(context, result);
            return Results.Ok(result.Product);
        });
        // Lets the interface learn the outcome of a save whose response was lost, without writing again.
        app.MapGet("/api/admin/operations/{key:guid}", async (HttpContext context, Guid key, IAdminProducts products, CancellationToken ct) =>
            await products.FindOperationAsync(new SaveIntent(key, Owner(context)), ct) is { } operation
                ? Results.Ok(operation)
                : Results.Problem(statusCode: 404, title: "Сохранение с этим ключом не выполнялось.",
                    extensions: new Dictionary<string, object?> { ["code"] = ShopErrorCodes.OperationNotFound }))
            .RequireAuthorization("Admin");
    }

    private static SaveIntent? Intent(HttpContext context) =>
        context.Request.Headers[IdempotencyKeyHeader] is [{ } value] && Guid.TryParseExact(value, "D", out var key) && key != Guid.Empty
            ? new SaveIntent(key, Owner(context)) : null;

    private static long Owner(HttpContext context) =>
        long.Parse(context.User.FindFirstValue(ClaimTypes.NameIdentifier)!, CultureInfo.InvariantCulture);

    private static IResult MissingKey() => Results.Problem(statusCode: 400,
        title: "Не передан ключ сохранения. Обновите страницу и повторите.",
        extensions: new Dictionary<string, object?> { ["code"] = ShopErrorCodes.IdempotencyKeyRequired });

    private static void MarkReplay(HttpContext context, SaveResult result)
    {
        if (result.Replayed) context.Response.Headers[ReplayedHeader] = "true";
    }
}
