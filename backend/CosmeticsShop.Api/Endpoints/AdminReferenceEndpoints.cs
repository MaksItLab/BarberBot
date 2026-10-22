using CosmeticsShop.Application.Admin;
using CosmeticsShop.Contracts.Admin;

namespace CosmeticsShop.Api.Endpoints;

public static class AdminReferenceEndpoints
{
    public static void MapAdminReferences(this WebApplication app)
    {
        var group = app.MapGroup("/api/admin").RequireAuthorization("Admin");
        group.MapGet("/brands", async (IAdminReferenceData data, CancellationToken ct) => Results.Ok(await data.GetBrandsAsync(ct)));
        group.MapGet("/types", async (IAdminReferenceData data, CancellationToken ct) => Results.Ok(await data.GetTypesAsync(ct)));
        group.MapPost("/brands", async (SaveBrandRequest request, IAdminReferenceData data, CancellationToken ct) =>
        {
            var brand = await data.SaveBrandAsync(null, request, ct);
            return Results.Created($"/api/admin/brands/{brand.Id}", brand);
        });
        group.MapPost("/types", async (SaveTypeRequest request, IAdminReferenceData data, CancellationToken ct) =>
        {
            var type = await data.SaveTypeAsync(null, request, ct);
            return Results.Created($"/api/admin/types/{type.Id}", type);
        });
        group.MapPut("/brands/{id:long}", async (long id, SaveBrandRequest request, IAdminReferenceData data, CancellationToken ct) => Results.Ok(await data.SaveBrandAsync(id, request, ct)));
        group.MapPut("/types/{id:long}", async (long id, SaveTypeRequest request, IAdminReferenceData data, CancellationToken ct) => Results.Ok(await data.SaveTypeAsync(id, request, ct)));
    }
}
