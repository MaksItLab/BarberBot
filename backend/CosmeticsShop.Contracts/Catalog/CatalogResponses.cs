namespace CosmeticsShop.Contracts.Catalog;

public sealed record CatalogOption(string Id, string Name);
public sealed record ProductSummary(
    string Id, string Name, string BrandName, string? ImagePath, decimal PriceRub, bool HasPriceRange);
public sealed record ProductPage(IReadOnlyList<ProductSummary> Items, int Page, int PageSize, bool HasMore);
public sealed record ProductVariantResponse(string Id, string? Volume, string? Size, string? Shade, decimal PriceRub);
public sealed record ProductDetails(
    string Id, string Name, string Description, string BrandName, string? BrandDescription,
    string TypeName, string? ImagePath, IReadOnlyList<ProductVariantResponse> Variants);
