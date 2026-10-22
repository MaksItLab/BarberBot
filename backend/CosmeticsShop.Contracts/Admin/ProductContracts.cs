namespace CosmeticsShop.Contracts.Admin;

public sealed record SaveVariantRequest(string? Id, string? Volume, string? Size, string? Shade, decimal? PriceRub, bool IsVisible);
public sealed record SaveProductRequest(string? Name, string? Description, string? BrandId, string? TypeId,
    string? ImagePath, bool IsVisible, string? Version, IReadOnlyList<SaveVariantRequest?>? Variants);
public sealed record AdminVariant(string Id, string? Volume, string? Size, string? Shade, decimal PriceRub, bool IsVisible);
public sealed record AdminProduct(string Id, string Name, string Description, string BrandId, string TypeId,
    string? ImagePath, bool IsVisible, string Version, IReadOnlyList<AdminVariant> Variants);
public sealed record AdminProductSummary(string Id, string Name, string BrandName, bool IsVisible);
/// <summary>Outcome of a save by its Idempotency-Key. Kind: product.create or product.update.</summary>
public sealed record SaveOperationResponse(string Kind, string ProductId);
public sealed record AdminProductPage(IReadOnlyList<AdminProductSummary> Items, int Page, int PageSize, bool HasMore);
