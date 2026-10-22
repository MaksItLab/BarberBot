using System.Buffers.Binary;
using CosmeticsShop.Application.Admin;
using CosmeticsShop.Application.Catalog;
using CosmeticsShop.Application.Common;
using CosmeticsShop.Contracts.Admin;
using CosmeticsShop.Domain;
using CosmeticsShop.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace CosmeticsShop.Infrastructure.Admin;

public sealed class AdminProducts(ShopDbContext db) : IAdminProducts
{
    public async Task<AdminProductPage> GetProductsAsync(CatalogQuery query, CancellationToken cancellationToken)
    {
        if (!query.IsValid) throw new ShopFailureException(ShopFailureKind.Invalid, "Некорректная страница.");
        var products = db.Products.AsNoTracking().AsQueryable();
        if (query.BrandId is { } brand) products = products.Where(product => product.BrandId == brand);
        if (query.TypeId is { } type) products = products.Where(product => product.CosmeticTypeId == type);
        var rows = await products.OrderBy(product => product.Id).Skip(query.Offset).Take(query.PageSize + 1)
            .Select(product => new AdminProductSummary(product.Id.ToString(), product.Name, product.Brand.Name, product.IsVisible))
            .ToListAsync(cancellationToken);
        return new(rows.Take(query.PageSize).ToArray(), query.Page, query.PageSize, rows.Count > query.PageSize);
    }

    public async Task<AdminProduct> GetProductAsync(long id, CancellationToken cancellationToken)
    {
        var product = await db.Products.AsNoTracking().Include(product => product.Variants).SingleOrDefaultAsync(product => product.Id == id, cancellationToken)
            ?? throw new ShopFailureException(ShopFailureKind.NotFound, "Товар не найден.");
        return Response(product);
    }

    public async Task<AdminProduct> SaveAsync(long? id, SaveProductRequest request, CancellationToken cancellationToken)
    {
        var input = ProductRules.Validate(request);
        if (!await db.Brands.AnyAsync(brand => brand.Id == input.BrandId, cancellationToken)
            || !await db.CosmeticTypes.AnyAsync(type => type.Id == input.TypeId, cancellationToken))
            throw new ShopFailureException(ShopFailureKind.Invalid, "Выберите существующий бренд и тип косметики.");
        var product = id is null ? new Product { Name = input.Name, Description = input.Description }
            : await db.Products.Include(product => product.Variants).SingleOrDefaultAsync(product => product.Id == id, cancellationToken)
                ?? throw new ShopFailureException(ShopFailureKind.NotFound, "Товар не найден.");
        if (id is not null && product.Version != DecodeVersion(request.Version)) Conflict();
        if (input.Variants.Any(value => value.Id is { } variantId && !product.Variants.Any(existing => existing.Id == variantId)))
            throw new ShopFailureException(ShopFailureKind.Invalid, "Вариант не принадлежит этому товару.");
        if (product.Variants.Any(existing => !input.Variants.Any(value => value.Id == existing.Id)))
            throw new ShopFailureException(ShopFailureKind.Invalid, "Существующие варианты нельзя удалять. Скройте ненужные варианты.");
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        try
        {
            if (id is null) db.Products.Add(product);
            else
            {
                db.Entry(product).Property(value => value.Version).OriginalValue = DecodeVersion(request.Version);
                // Updating the parent also guards changes made only to its variants.
                db.Entry(product).Property(value => value.Name).IsModified = true;
            }
            product.Name = input.Name; product.Description = input.Description;
            product.BrandId = input.BrandId; product.CosmeticTypeId = input.TypeId;
            product.ImagePath = input.ImagePath; product.IsVisible = input.IsVisible;
            var changedOptions = product.Variants.Where(existing => input.Variants.Any(value => value.Id == existing.Id
                && (value.Volume != existing.Volume || value.Size != existing.Size || value.Shade != existing.Shade))).ToArray();
            // Temporary distinct options allow swapping two variants under the immediate unique index.
            // They are never committed: both saves belong to this transaction.
            foreach (var variant in changedOptions) { variant.Volume = "~" + Guid.NewGuid().ToString("N"); variant.Size = null; variant.Shade = null; }
            if (changedOptions.Length > 0) await db.SaveChangesAsync(cancellationToken);
            foreach (var value in input.Variants)
            {
                var variant = value.Id is null ? new ProductVariant() : product.Variants.Single(existing => existing.Id == value.Id);
                if (value.Id is null) product.Variants.Add(variant);
                variant.Volume = value.Volume; variant.Size = value.Size; variant.Shade = value.Shade;
                variant.PriceRub = value.PriceRub; variant.IsVisible = value.IsVisible;
            }
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return Response(product);
        }
        catch (DbUpdateConcurrencyException) { Conflict(); throw; }
        catch (DbUpdateException exception) when (exception.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        { throw new ShopFailureException(ShopFailureKind.Conflict, "У товара уже есть вариант с такими характеристиками."); }
        catch (DbUpdateException exception) when (exception.InnerException is PostgresException { SqlState: PostgresErrorCodes.ForeignKeyViolation })
        { throw new ShopFailureException(ShopFailureKind.Invalid, "Бренд или тип больше не существует. Обновите справочники."); }
    }

    private static void Conflict() => throw new ShopFailureException(ShopFailureKind.Conflict, "Товар уже изменён другим администратором. Скопируйте свои изменения и заново откройте товар.");
    private static uint DecodeVersion(string? value)
    {
        Span<byte> buffer = stackalloc byte[4];
        if (value is null || !Convert.TryFromBase64String(value, buffer, out var written) || written != 4)
            throw new ShopFailureException(ShopFailureKind.Invalid, "Не передана корректная версия товара.");
        return BinaryPrimitives.ReadUInt32BigEndian(buffer);
    }
    private static string EncodeVersion(uint value)
    {
        Span<byte> buffer = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(buffer, value);
        return Convert.ToBase64String(buffer);
    }
    private static AdminProduct Response(Product product) => new(product.Id.ToString(), product.Name, product.Description,
        product.BrandId.ToString(), product.CosmeticTypeId.ToString(), product.ImagePath, product.IsVisible, EncodeVersion(product.Version),
        product.Variants.OrderBy(value => value.Id).Select(value => new AdminVariant(value.Id.ToString(), value.Volume, value.Size, value.Shade, value.PriceRub, value.IsVisible)).ToArray());
}
