namespace CosmeticsShop.Domain;

public sealed class ProductVariant
{
    public long Id { get; set; }
    public long ProductId { get; set; }
    public Product Product { get; set; } = null!;
    public string? Volume { get; set; }
    public string? Size { get; set; }
    public string? Shade { get; set; }
    public decimal PriceRub { get; set; }
    public bool IsVisible { get; set; } = true;
}
