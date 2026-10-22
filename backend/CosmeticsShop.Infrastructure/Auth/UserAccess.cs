using System.Globalization;
using CosmeticsShop.Application.Auth;
using CosmeticsShop.Contracts.Auth;
using CosmeticsShop.Domain;
using CosmeticsShop.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;

namespace CosmeticsShop.Infrastructure.Auth;

public sealed class UserAccess(ShopDbContext db) : IUserAccess
{
    public async Task<CurrentUserResponse?> FindAsync(long telegramId, CancellationToken cancellationToken)
    {
        var user = await db.Users.AsNoTracking().SingleOrDefaultAsync(user => user.TelegramId == telegramId, cancellationToken);
        return user is null ? null : new(user.TelegramId.ToString(CultureInfo.InvariantCulture), user.Role.ToString());
    }

    public async Task<CurrentUserResponse> RegisterCustomerAsync(long telegramId, CancellationToken cancellationToken)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(telegramId);
        await db.Database.ExecuteSqlInterpolatedAsync($"INSERT INTO users (telegram_id, role) VALUES ({telegramId}, 'Customer') ON CONFLICT (telegram_id) DO NOTHING", cancellationToken);
        return (await FindAsync(telegramId, cancellationToken))!;
    }

    public async Task GrantAdminAsync(long telegramId, CancellationToken cancellationToken)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(telegramId);
        await db.Database.ExecuteSqlInterpolatedAsync($"INSERT INTO users (telegram_id, role) VALUES ({telegramId}, 'Admin') ON CONFLICT (telegram_id) DO UPDATE SET role = 'Admin'", cancellationToken);
    }
}
