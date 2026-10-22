using CosmeticsShop.Application.Abstractions;
using Microsoft.EntityFrameworkCore;

namespace CosmeticsShop.Infrastructure.Data;

internal sealed class DatabaseReadiness(ShopDbContext db) : IApplicationReadiness
{
    public async Task<bool> IsReadyAsync(CancellationToken cancellationToken = default)
    {
        if (!await db.Database.CanConnectAsync(cancellationToken)) return false;
        var pending = await db.Database.GetPendingMigrationsAsync(cancellationToken);
        return !pending.Any();
    }
}
