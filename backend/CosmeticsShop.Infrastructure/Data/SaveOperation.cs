namespace CosmeticsShop.Infrastructure.Data;

/// <summary>
/// Stored result of an admin save, written in the same transaction as the product.
/// Lets a repeated request with the same Idempotency-Key return the first result.
/// </summary>
public sealed class SaveOperation
{
    public const string CreateProduct = "product.create";
    public const string UpdateProduct = "product.update";
    public static readonly TimeSpan Retention = TimeSpan.FromDays(7);

    public long OwnerTelegramId { get; set; }
    public Guid Key { get; set; }
    public required string Kind { get; set; }
    public required byte[] Fingerprint { get; set; }
    public long? ProductId { get; set; }
    public DateTime CreatedAt { get; set; }
}
