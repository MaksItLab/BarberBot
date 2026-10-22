using CosmeticsShop.Contracts.Auth;

namespace CosmeticsShop.Application.Auth;

public interface IUserAccess
{
    Task<CurrentUserResponse?> FindAsync(long telegramId, CancellationToken cancellationToken);
    Task<CurrentUserResponse> RegisterCustomerAsync(long telegramId, CancellationToken cancellationToken);
    Task GrantAdminAsync(long telegramId, CancellationToken cancellationToken);
}

public enum TelegramInitDataStatus { Valid, Invalid, Expired }

public readonly record struct TelegramInitDataCheck(TelegramInitDataStatus Status, long? TelegramId = null);

public interface ITelegramIdentityValidator
{
    TelegramInitDataCheck Check(string initData);
}
