using CosmeticsShop.Contracts.Catalog;

namespace CosmeticsShop.Application.Catalog;

public sealed record CatalogQuery(long? BrandId, long? TypeId, int Page = 1, int PageSize = 20)
{
    public bool IsValid => (BrandId is null or > 0) && (TypeId is null or > 0)
        && Page > 0 && PageSize is > 0 and <= 60
        && (long)(Page - 1) * PageSize <= int.MaxValue - 61;
    public int Offset => checked((Page - 1) * PageSize);
}

public interface ICatalogReader
{
    Task<ProductPage> GetProductsAsync(CatalogQuery query, CancellationToken cancellationToken);
    Task<IReadOnlyList<CatalogOption>> GetBrandsAsync(CancellationToken cancellationToken);
    Task<IReadOnlyList<CatalogOption>> GetTypesAsync(CancellationToken cancellationToken);
    Task<ProductDetails?> GetProductAsync(long id, CancellationToken cancellationToken);
}
