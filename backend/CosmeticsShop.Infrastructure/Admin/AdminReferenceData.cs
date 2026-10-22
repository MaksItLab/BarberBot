using CosmeticsShop.Application.Admin;
using CosmeticsShop.Application.Common;
using CosmeticsShop.Contracts.Admin;
using CosmeticsShop.Domain;
using CosmeticsShop.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace CosmeticsShop.Infrastructure.Admin;

public sealed class AdminReferenceData(ShopDbContext db) : IAdminReferenceData
{
    public async Task<IReadOnlyList<BrandResponse>> GetBrandsAsync(CancellationToken cancellationToken) =>
        await db.Brands.AsNoTracking().OrderBy(brand => brand.Name).ThenBy(brand => brand.Id)
            .Select(brand => new BrandResponse(brand.Id.ToString(), brand.Name, brand.Description)).ToListAsync(cancellationToken);

    public async Task<IReadOnlyList<TypeResponse>> GetTypesAsync(CancellationToken cancellationToken) =>
        await db.CosmeticTypes.AsNoTracking().OrderBy(type => type.Name).ThenBy(type => type.Id)
            .Select(type => new TypeResponse(type.Id.ToString(), type.Name)).ToListAsync(cancellationToken);

    public async Task<BrandResponse> SaveBrandAsync(long? id, SaveBrandRequest request, CancellationToken cancellationToken)
    {
        var name = InputRules.Required(request.Name, 160, "Название бренда");
        var description = InputRules.Optional(request.Description, 4000, "Описание бренда");
        var brand = id is null ? new Brand { Name = name } : await db.Brands.SingleOrDefaultAsync(brand => brand.Id == id, cancellationToken)
            ?? throw new ShopFailureException(ShopFailureKind.NotFound, "Бренд не найден.");
        if (id is null) db.Brands.Add(brand);
        brand.Name = name; brand.Description = description;
        await SaveAsync(cancellationToken);
        return new(brand.Id.ToString(), brand.Name, brand.Description);
    }

    public async Task<TypeResponse> SaveTypeAsync(long? id, SaveTypeRequest request, CancellationToken cancellationToken)
    {
        var name = InputRules.Required(request.Name, 100, "Название типа косметики");
        var type = id is null ? new CosmeticType { Name = name } : await db.CosmeticTypes.SingleOrDefaultAsync(type => type.Id == id, cancellationToken)
            ?? throw new ShopFailureException(ShopFailureKind.NotFound, "Тип косметики не найден.");
        if (id is null) db.CosmeticTypes.Add(type);
        type.Name = name;
        await SaveAsync(cancellationToken);
        return new(type.Id.ToString(), type.Name);
    }

    private async Task SaveAsync(CancellationToken cancellationToken)
    {
        try { await db.SaveChangesAsync(cancellationToken); }
        catch (DbUpdateException exception) when (exception.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            throw new ShopFailureException(ShopFailureKind.Conflict, "Такое название уже существует.");
        }
    }
}
