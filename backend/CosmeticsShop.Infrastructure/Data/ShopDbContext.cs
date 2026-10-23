using CosmeticsShop.Domain;
using Microsoft.EntityFrameworkCore;

namespace CosmeticsShop.Infrastructure.Data;

public sealed class ShopDbContext(DbContextOptions<ShopDbContext> options) : DbContext(options)
{
    public DbSet<Brand> Brands => Set<Brand>();
    public DbSet<CosmeticType> CosmeticTypes => Set<CosmeticType>();
    public DbSet<Product> Products => Set<Product>();
    public DbSet<ProductVariant> ProductVariants => Set<ProductVariant>();
    public DbSet<ShopUser> Users => Set<ShopUser>();
    public DbSet<SaveOperation> SaveOperations => Set<SaveOperation>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
        => modelBuilder.ApplyConfigurationsFromAssembly(typeof(ShopDbContext).Assembly);

    public override int SaveChanges(bool acceptAllChangesOnSuccess)
    {
        StampProducts();
        return base.SaveChanges(acceptAllChangesOnSuccess);
    }

    public override Task<int> SaveChangesAsync(bool acceptAllChangesOnSuccess,
        CancellationToken cancellationToken = default)
    {
        StampProducts();
        return base.SaveChangesAsync(acceptAllChangesOnSuccess, cancellationToken);
    }

    private void StampProducts()
    {
        var now = DateTime.UtcNow;
        foreach (var entry in ChangeTracker.Entries<Product>())
        {
            if (entry.State == EntityState.Added)
            {
                entry.Entity.CreatedAt = now;
                entry.Entity.UpdatedAt = now;
            }
            else if (entry.State == EntityState.Modified)
            {
                entry.Entity.UpdatedAt = now;
                entry.Property(product => product.CreatedAt).IsModified = false;
            }
        }
    }
}
