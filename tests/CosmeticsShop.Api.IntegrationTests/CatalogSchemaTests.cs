using CosmeticsShop.Infrastructure.Data;
using CosmeticsShop.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql;

namespace CosmeticsShop.Api.IntegrationTests;

public sealed class CatalogSchemaTests(PostgresFixture fixture) : IClassFixture<PostgresFixture>
{
    [Fact]
    public async Task OneProductStoresMultipleVariantsWithExactRublePrices()
    {
        await using var db = fixture.CreateContext();
        await using var transaction = await db.Database.BeginTransactionAsync();
        var product = NewProduct();
        product.Variants.Add(new ProductVariant { Volume = "50 мл", PriceRub = 900.19m });
        product.Variants.Add(new ProductVariant { Volume = "100 мл", PriceRub = 1500.99m });
        db.Products.Add(product);
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();

        var loaded = await db.Products.Include(item => item.Variants)
            .Include(item => item.Brand).Include(item => item.CosmeticType).SingleAsync();
        Assert.Equal(2, loaded.Variants.Count);
        Assert.Equal([900.19m, 1500.99m], loaded.Variants.OrderBy(item => item.PriceRub).Select(item => item.PriceRub));
        Assert.NotNull(loaded.Brand);
        Assert.NotNull(loaded.CosmeticType);
        Assert.Null(loaded.ImagePath);
        Assert.Equal(DateTimeKind.Utc, loaded.CreatedAt.Kind);
    }

    [Theory]
    [InlineData(null, null, null)]
    [InlineData("50 мл", null, null)]
    [InlineData("30 мл", "M", "02")]
    public async Task DuplicateVariantOptionsAreRejectedIncludingNulls(string? volume, string? size, string? shade)
    {
        await using var db = fixture.CreateContext();
        await using var transaction = await db.Database.BeginTransactionAsync();
        var product = NewProduct();
        product.Variants.Add(new ProductVariant { Volume = volume, Size = size, Shade = shade, PriceRub = 100m });
        db.Products.Add(product);
        await db.SaveChangesAsync();
        db.ProductVariants.Add(new ProductVariant
        {
            ProductId = product.Id, Volume = volume, Size = size, Shade = shade, PriceRub = 200m
        });

        await AssertConstraintViolation(db, PostgresErrorCodes.UniqueViolation);
    }

    [Fact]
    public async Task NegativePricesAreRejectedByDatabase()
    {
        await using var db = fixture.CreateContext();
        await using var transaction = await db.Database.BeginTransactionAsync();
        var product = NewProduct();
        product.Variants.Add(new ProductVariant { PriceRub = -0.01m });
        db.Products.Add(product);
        await AssertConstraintViolation(db, PostgresErrorCodes.CheckViolation);
    }

    [Fact]
    public async Task HiddenVariantRemainsHiddenDespiteVisibleDefault()
    {
        await using var db = fixture.CreateContext();
        await using var transaction = await db.Database.BeginTransactionAsync();
        var product = NewProduct();
        product.Variants.Add(new ProductVariant { Volume = "50 мл", PriceRub = 100m, IsVisible = false });
        product.Variants.Add(new ProductVariant { Volume = "100 мл", PriceRub = 200m });
        db.Products.Add(product);
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();

        var variants = await db.ProductVariants.OrderBy(item => item.PriceRub).ToListAsync();
        Assert.False(variants[0].IsVisible);
        Assert.True(variants[1].IsVisible);
    }

    [Theory]
    [InlineData(0, UserRole.Customer)]
    [InlineData(123, (UserRole)42)]
    public async Task InvalidTelegramIdsAndRolesAreRejected(long telegramId, UserRole role)
    {
        await using var db = fixture.CreateContext();
        await using var transaction = await db.Database.BeginTransactionAsync();
        db.Users.Add(new ShopUser { TelegramId = telegramId, Role = role });
        await AssertConstraintViolation(db, PostgresErrorCodes.CheckViolation);
    }

    [Fact]
    public async Task TelegramIdSupportsLargeValuesAndIsUnique()
    {
        await using var db = fixture.CreateContext();
        await using var transaction = await db.Database.BeginTransactionAsync();
        const long telegramId = 9_000_000_001;
        db.Users.Add(new ShopUser { TelegramId = telegramId });
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();
        var user = await db.Users.SingleAsync();
        Assert.Equal(telegramId, user.TelegramId);
        Assert.Equal(UserRole.Customer, user.Role);
        db.Users.Add(new ShopUser { TelegramId = telegramId, Role = UserRole.Admin });
        await AssertConstraintViolation(db, PostgresErrorCodes.UniqueViolation);
    }

    [Fact]
    public async Task BrandInUseCannotBeDeleted()
    {
        await using var db = fixture.CreateContext();
        await using var transaction = await db.Database.BeginTransactionAsync();
        var product = NewProduct();
        db.Products.Add(product);
        await db.SaveChangesAsync();
        var exception = await Assert.ThrowsAsync<PostgresException>(() =>
            db.Brands.Where(brand => brand.Id == product.BrandId).ExecuteDeleteAsync());
        Assert.Equal(PostgresErrorCodes.RestrictViolation, exception.SqlState);
    }

    [Fact]
    public async Task VariantCannotReferenceMissingProduct()
    {
        await using var db = fixture.CreateContext();
        await using var transaction = await db.Database.BeginTransactionAsync();
        db.ProductVariants.Add(new ProductVariant { ProductId = long.MaxValue, PriceRub = 100m });
        await AssertConstraintViolation(db, PostgresErrorCodes.ForeignKeyViolation);
    }

    [Fact]
    public async Task ProductEditUpdatesTimestampAndPreservesCreationDate()
    {
        await using var db = fixture.CreateContext();
        await using var transaction = await db.Database.BeginTransactionAsync();
        var product = NewProduct();
        db.Products.Add(product);
        await db.SaveChangesAsync();
        await db.Entry(product).ReloadAsync();
        var createdAt = product.CreatedAt;
        var updatedAt = product.UpdatedAt;
        product.CreatedAt = createdAt.AddDays(1);
        product.Description = "Обновлённое описание";
        await db.SaveChangesAsync();
        await db.Entry(product).ReloadAsync();

        Assert.Equal(createdAt, product.CreatedAt);
        Assert.True(product.UpdatedAt >= updatedAt);
        Assert.Equal("Обновлённое описание", product.Description);
    }

    [Fact]
    public async Task ProductDeletionRemovesItsVariants()
    {
        await using var db = fixture.CreateContext();
        await using var transaction = await db.Database.BeginTransactionAsync();
        var product = NewProduct();
        product.Variants.Add(new ProductVariant { PriceRub = 100m });
        db.Products.Add(product);
        await db.SaveChangesAsync();
        await db.Products.Where(item => item.Id == product.Id).ExecuteDeleteAsync();
        Assert.False(await db.ProductVariants.AnyAsync(item => item.ProductId == product.Id));
    }

    [Fact]
    public void ExistingMigrationIdentityIsPreserved()
    {
        using var db = fixture.CreateContext();
        Assert.Equal(["20261015081714_InitialCatalog", "20261015090947_ProductConcurrency", "20261022113732_SaveOperations"], db.Database.GetMigrations());
    }

    [Fact]
    public async Task MigrationCanBeRolledBackReappliedAndRepeated()
    {
        await using var db = fixture.CreateContext();
        var migrator = db.GetService<IMigrator>();
        await migrator.MigrateAsync("0");
        await db.Database.MigrateAsync();
        await db.Database.MigrateAsync();
        Assert.Empty(await db.Database.GetPendingMigrationsAsync());
        Assert.Empty(await db.Products.ToListAsync());
    }

    private static Product NewProduct() => new()
    {
        Name = "Крем для лица",
        Description = "Увлажняющий крем для ежедневного ухода",
        Brand = new Brand { Name = "Тестовый бренд" },
        CosmeticType = new CosmeticType { Name = "Крем" },
        IsVisible = true
    };

    private static async Task AssertConstraintViolation(ShopDbContext db, string expectedCode)
    {
        var exception = await Assert.ThrowsAsync<DbUpdateException>(() => db.SaveChangesAsync());
        Assert.Equal(expectedCode, Assert.IsType<PostgresException>(exception.InnerException).SqlState);
    }
}
