namespace CosmeticsShop.Contracts.Auth;

public sealed record CurrentUserResponse(string TelegramId, string Role);
