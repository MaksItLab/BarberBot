namespace CosmeticsShop.Domain;

public sealed class Brand
{
    public long Id { get; set; }
    public required string Name { get; set; }
    public string? Description { get; set; }
    public ICollection<Product> Products { get; set; } = [];
}
