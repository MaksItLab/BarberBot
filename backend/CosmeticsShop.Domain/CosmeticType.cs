namespace CosmeticsShop.Domain;

public sealed class CosmeticType
{
    public long Id { get; set; }
    public required string Name { get; set; }
    public ICollection<Product> Products { get; set; } = [];
}
