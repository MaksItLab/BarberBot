namespace CosmeticsShop.Domain;

public sealed class Product
{
    public long Id { get; set; }
    public required string Name { get; set; }
    public required string Description { get; set; }
    public string? ImagePath { get; set; }
    public long BrandId { get; set; }
    public Brand Brand { get; set; } = null!;
    public long CosmeticTypeId { get; set; }
    public CosmeticType CosmeticType { get; set; } = null!;
    public bool IsVisible { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
    public uint Version { get; set; }
    public ICollection<ProductVariant> Variants { get; set; } = [];
}
