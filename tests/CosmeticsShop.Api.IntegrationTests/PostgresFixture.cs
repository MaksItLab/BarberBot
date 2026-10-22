using CosmeticsShop.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace CosmeticsShop.Api.IntegrationTests;

public sealed class PostgresFixture : IAsyncLifetime
{
    private readonly string databaseName = $"cosmetics_test_{Guid.NewGuid():N}";
    private string adminConnectionString = "";
    private string connectionString = "";
    private bool databaseCreated;

    public ShopDbContext CreateContext() => new(new DbContextOptionsBuilder<ShopDbContext>()
        .UseNpgsql(connectionString).Options);

    public async Task InitializeAsync()
    {
        var configured = Environment.GetEnvironmentVariable("SHOP_TEST_ADMIN_CONNECTION");
        if (string.IsNullOrWhiteSpace(configured))
            throw new InvalidOperationException("Run scripts/test-database.ps1, or set SHOP_TEST_ADMIN_CONNECTION to a PostgreSQL account allowed to create test databases.");

        var settings = new NpgsqlConnectionStringBuilder(configured) { Database = "postgres" };
        adminConnectionString = settings.ConnectionString;
        await using var admin = new NpgsqlConnection(adminConnectionString);
        await admin.OpenAsync();
        await using var create = new NpgsqlCommand($"CREATE DATABASE \"{databaseName}\"", admin);
        await create.ExecuteNonQueryAsync();
        databaseCreated = true;
        settings.Database = databaseName;
        connectionString = settings.ConnectionString;
        await using var db = CreateContext();
        await db.Database.MigrateAsync();
    }

    public async Task DisposeAsync()
    {
        if (!databaseCreated) return;
        // Only drop the random database created by this fixture, never a configured database.
        NpgsqlConnection.ClearAllPools();
        await using var admin = new NpgsqlConnection(adminConnectionString);
        await admin.OpenAsync();
        await using var drop = new NpgsqlCommand($"DROP DATABASE \"{databaseName}\" WITH (FORCE)", admin);
        await drop.ExecuteNonQueryAsync();
    }
}
