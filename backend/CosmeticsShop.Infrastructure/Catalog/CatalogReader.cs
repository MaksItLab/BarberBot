using CosmeticsShop.Application.Catalog;
using CosmeticsShop.Contracts.Catalog;
using CosmeticsShop.Domain;
using CosmeticsShop.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;

namespace CosmeticsShop.Infrastructure.Catalog;

public sealed class CatalogReader(ShopDbContext db) : ICatalogReader
{
    private IQueryable<Product> Published => db.Products.AsNoTracking()
        .Where(product => product.IsVisible && product.Variants.Any(variant => variant.IsVisible));

    public async Task<ProductPage> GetProductsAsync(CatalogQuery query, CancellationToken cancellationToken)
    {
        if (!query.IsValid) throw new ArgumentOutOfRangeException(nameof(query));
        var products = Published;
        if (query.BrandId is { } brandId) products = products.Where(product => product.BrandId == brandId);
        if (query.TypeId is { } typeId) products = products.Where(product => product.CosmeticTypeId == typeId);
        var rows = await products.OrderBy(product => product.Id).Skip(query.Offset).Take(query.PageSize + 1)
            .Select(product => new ProductSummary(product.Id.ToString(), product.Name, product.Brand.Name,
                product.ImagePath, product.Variants.Where(variant => variant.IsVisible).Min(variant => variant.PriceRub),
                product.Variants.Where(variant => variant.IsVisible).Min(variant => variant.PriceRub)
                    != product.Variants.Where(variant => variant.IsVisible).Max(variant => variant.PriceRub)))
            .ToListAsync(cancellationToken);
        return new ProductPage(rows.Take(query.PageSize).ToArray(), query.Page, query.PageSize, rows.Count > query.PageSize);
    }

    public async Task<IReadOnlyList<CatalogOption>> GetBrandsAsync(CancellationToken cancellationToken) =>
        await db.Brands.AsNoTracking().Where(brand => Published.Any(product => product.BrandId == brand.Id))
            .OrderBy(brand => brand.Name).ThenBy(brand => brand.Id)
            .Select(brand => new CatalogOption(brand.Id.ToString(), brand.Name)).ToListAsync(cancellationToken);

    public async Task<IReadOnlyList<CatalogOption>> GetTypesAsync(CancellationToken cancellationToken) =>
        await db.CosmeticTypes.AsNoTracking().Where(type => Published.Any(product => product.CosmeticTypeId == type.Id))
            .OrderBy(type => type.Name).ThenBy(type => type.Id)
            .Select(type => new CatalogOption(type.Id.ToString(), type.Name)).ToListAsync(cancellationToken);

    public Task<ProductDetails?> GetProductAsync(long id, CancellationToken cancellationToken) =>
        Published.Where(product => product.Id == id).Select(product => new ProductDetails(
            product.Id.ToString(), product.Name, product.Description, product.Brand.Name,
            product.Brand.Description, product.CosmeticType.Name, product.ImagePath,
            product.Variants.Where(variant => variant.IsVisible)
                .OrderBy(variant => variant.PriceRub).ThenBy(variant => variant.Id)
                .Select(variant => new ProductVariantResponse(variant.Id.ToString(), variant.Volume,
                    variant.Size, variant.Shade, variant.PriceRub)).ToList()))
            .SingleOrDefaultAsync(cancellationToken);
}
