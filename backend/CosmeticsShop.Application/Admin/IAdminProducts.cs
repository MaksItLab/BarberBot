using CosmeticsShop.Application.Catalog;
using CosmeticsShop.Contracts.Admin;

namespace CosmeticsShop.Application.Admin;

/// <summary>One admin's intent to save: repeating the same key returns the first result instead of writing again.</summary>
public readonly record struct SaveIntent(Guid Key, long OwnerTelegramId);

/// <summary><paramref name="Replayed"/> is true when the key was already used and nothing new was written.</summary>
public sealed record SaveResult(AdminProduct Product, bool Replayed);

public interface IAdminProducts
{
    Task<AdminProductPage> GetProductsAsync(CatalogQuery query, CancellationToken cancellationToken);
    Task<AdminProduct> GetProductAsync(long id, CancellationToken cancellationToken);
    Task<SaveResult> SaveAsync(long? id, SaveProductRequest request, SaveIntent intent, CancellationToken cancellationToken);
    Task<SaveOperationResponse?> FindOperationAsync(SaveIntent intent, CancellationToken cancellationToken);
}
