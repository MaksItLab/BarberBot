using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text.Json;
using CosmeticsShop.Application.Admin;
using CosmeticsShop.Application.Catalog;
using CosmeticsShop.Application.Common;
using CosmeticsShop.Contracts.Admin;
using CosmeticsShop.Domain;
using CosmeticsShop.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Npgsql;

namespace CosmeticsShop.Infrastructure.Admin;

public sealed class AdminProducts(ShopDbContext db, TimeProvider clock) : IAdminProducts
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

    public async Task<SaveOperationResponse?> FindOperationAsync(SaveIntent intent, CancellationToken cancellationToken)
    {
        var operation = await FindAsync(intent, cancellationToken);
        return operation?.ProductId is { } productId ? new(operation.Kind, productId.ToString()) : null;
    }

    public async Task<SaveResult> SaveAsync(long? id, SaveProductRequest request, SaveIntent intent, CancellationToken cancellationToken)
    {
        var input = ProductRules.Validate(request);
        var kind = id is null ? SaveOperation.CreateProduct : SaveOperation.UpdateProduct;
        var fingerprint = Fingerprint(kind, id, request.Version, input);
        if (await ReplayAsync(intent, kind, fingerprint, cancellationToken) is { } replay) return replay;
        var expired = clock.GetUtcNow().UtcDateTime - SaveOperation.Retention;
        await db.SaveOperations.Where(operation => operation.OwnerTelegramId == intent.OwnerTelegramId && operation.CreatedAt < expired)
            .ExecuteDeleteAsync(cancellationToken);
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        var operation = new SaveOperation { OwnerTelegramId = intent.OwnerTelegramId, Key = intent.Key, Kind = kind, Fingerprint = fingerprint };
        try
        {
            // First statement of the transaction: a concurrent request with the same key waits here
            // until the other one commits or rolls back, so the product is never written twice
            // and the version check below never sees this key's own committed change.
            db.SaveOperations.Add(operation);
            await db.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateException exception) when (exception.InnerException is PostgresException
            { SqlState: PostgresErrorCodes.UniqueViolation, ConstraintName: "pk_save_operations" })
        {
            await transaction.RollbackAsync(cancellationToken);
            db.ChangeTracker.Clear();
            return await ReplayAsync(intent, kind, fingerprint, cancellationToken)
                ?? throw new InvalidOperationException("A save operation conflicted but could not be read back.");
        }
        if (!await db.Brands.AnyAsync(brand => brand.Id == input.BrandId, cancellationToken)
            || !await db.CosmeticTypes.AnyAsync(type => type.Id == input.TypeId, cancellationToken))
            throw new ShopFailureException(ShopFailureKind.Invalid, "Выберите существующий бренд и тип косметики.");
        var product = id is null ? new Product { Name = input.Name, Description = input.Description }
            : await db.Products.Include(product => product.Variants).SingleOrDefaultAsync(product => product.Id == id, cancellationToken)
                ?? throw new ShopFailureException(ShopFailureKind.NotFound, "Товар не найден.");
        if (id is not null && product.Version != DecodeVersion(request.Version)) await ConflictAsync(product.Id, transaction, cancellationToken);
        if (input.Variants.Any(value => value.Id is { } variantId && !product.Variants.Any(existing => existing.Id == variantId)))
            throw new ShopFailureException(ShopFailureKind.Invalid, "Вариант не принадлежит этому товару.");
        if (product.Variants.Any(existing => !input.Variants.Any(value => value.Id == existing.Id)))
            throw new ShopFailureException(ShopFailureKind.Invalid, "Существующие варианты нельзя удалять. Скройте ненужные варианты.");
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
            operation.ProductId = product.Id;
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return new(Response(product), false);
        }
        catch (DbUpdateConcurrencyException) { await ConflictAsync(product.Id, transaction, cancellationToken); throw; }
        catch (DbUpdateException exception) when (exception.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        { throw new ShopFailureException(ShopFailureKind.Conflict, "У товара уже есть вариант с такими характеристиками."); }
        catch (DbUpdateException exception) when (exception.InnerException is PostgresException { SqlState: PostgresErrorCodes.ForeignKeyViolation })
        { throw new ShopFailureException(ShopFailureKind.Invalid, "Бренд или тип больше не существует. Обновите справочники."); }
    }

    private Task<SaveOperation?> FindAsync(SaveIntent intent, CancellationToken cancellationToken) =>
        db.SaveOperations.AsNoTracking().SingleOrDefaultAsync(operation =>
            operation.OwnerTelegramId == intent.OwnerTelegramId && operation.Key == intent.Key, cancellationToken);

    /// <summary>Returns the current state of the product saved earlier with this key, or null when the key is new.</summary>
    private async Task<SaveResult?> ReplayAsync(SaveIntent intent, string kind, byte[] fingerprint, CancellationToken cancellationToken)
    {
        var operation = await FindAsync(intent, cancellationToken);
        if (operation is null) return null;
        if (operation.Kind != kind || !CryptographicOperations.FixedTimeEquals(operation.Fingerprint, fingerprint) || operation.ProductId is not { } productId)
            throw new ShopFailureException(ShopFailureKind.KeyReused,
                "Этот ключ сохранения уже использован для других данных. Обновите страницу и повторите.");
        return new(await GetProductAsync(productId, cancellationToken), true);
    }

    /// <summary>SHA-256 of the normalized input, so spacing or "," vs "." in a price do not look like different data.</summary>
    private static byte[] Fingerprint(string kind, long? id, string? version, ValidProduct input) =>
        SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new { kind, id, version = id is null ? null : version, input }));

    /// <summary>Rolls back and reports the conflict with the product as it is now, so nothing is overwritten silently.</summary>
    private async Task ConflictAsync(long id, IDbContextTransaction transaction, CancellationToken cancellationToken)
    {
        await transaction.RollbackAsync(cancellationToken);
        db.ChangeTracker.Clear();
        var current = await GetProductAsync(id, cancellationToken);
        throw new ShopFailureException(ShopFailureKind.Conflict, "Товар уже изменён другим администратором.", current);
    }
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
