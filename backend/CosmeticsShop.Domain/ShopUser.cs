namespace CosmeticsShop.Domain;

public enum UserRole
{
    Customer,
    Admin
}

public sealed class ShopUser
{
    public long Id { get; set; }
    public long TelegramId { get; set; }
    public UserRole Role { get; set; } = UserRole.Customer;
    public DateTime CreatedAt { get; set; }
}
