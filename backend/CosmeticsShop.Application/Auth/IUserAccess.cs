using CosmeticsShop.Contracts.Auth;

namespace CosmeticsShop.Application.Auth;

public interface IUserAccess
{
    Task<CurrentUserResponse?> FindAsync(long telegramId, CancellationToken cancellationToken);
    Task<CurrentUserResponse> RegisterCustomerAsync(long telegramId, CancellationToken cancellationToken);
    Task GrantAdminAsync(long telegramId, CancellationToken cancellationToken);
}

public interface ITelegramIdentityValidator
{
    long? Validate(string initData);
}
