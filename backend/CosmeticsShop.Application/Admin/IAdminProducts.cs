using CosmeticsShop.Application.Catalog;
using CosmeticsShop.Contracts.Admin;

namespace CosmeticsShop.Application.Admin;

public interface IAdminProducts
{
    Task<AdminProductPage> GetProductsAsync(CatalogQuery query, CancellationToken cancellationToken);
    Task<AdminProduct> GetProductAsync(long id, CancellationToken cancellationToken);
    Task<AdminProduct> SaveAsync(long? id, SaveProductRequest request, CancellationToken cancellationToken);
}
