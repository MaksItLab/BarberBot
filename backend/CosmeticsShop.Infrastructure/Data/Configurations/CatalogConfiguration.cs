using CosmeticsShop.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace CosmeticsShop.Infrastructure.Data.Configurations;

internal sealed class BrandConfiguration : IEntityTypeConfiguration<Brand>
{
    public void Configure(EntityTypeBuilder<Brand> builder)
    {
        builder.ToTable("brands", table =>
            table.HasCheckConstraint("ck_brands_name", "name <> '' AND name = btrim(name)"));
        builder.HasKey(brand => brand.Id);
        builder.Property(brand => brand.Id).HasColumnName("id");
        builder.Property(brand => brand.Name).HasColumnName("name").HasMaxLength(160).IsRequired();
        builder.Property(brand => brand.Description).HasColumnName("description").HasMaxLength(4000);
        builder.HasIndex(brand => brand.Name).IsUnique().HasDatabaseName("ux_brands_name");
    }
}

internal sealed class CosmeticTypeConfiguration : IEntityTypeConfiguration<CosmeticType>
{
    public void Configure(EntityTypeBuilder<CosmeticType> builder)
    {
        builder.ToTable("cosmetic_types", table =>
            table.HasCheckConstraint("ck_cosmetic_types_name", "name <> '' AND name = btrim(name)"));
        builder.HasKey(type => type.Id);
        builder.Property(type => type.Id).HasColumnName("id");
        builder.Property(type => type.Name).HasColumnName("name").HasMaxLength(100).IsRequired();
        builder.HasIndex(type => type.Name).IsUnique().HasDatabaseName("ux_cosmetic_types_name");
    }
}

internal sealed class ProductConfiguration : IEntityTypeConfiguration<Product>
{
    public void Configure(EntityTypeBuilder<Product> builder)
    {
        builder.ToTable("products", table =>
        {
            table.HasCheckConstraint("ck_products_name", "name <> '' AND name = btrim(name)");
            table.HasCheckConstraint("ck_products_description", "btrim(description) <> ''");
        });
        builder.HasKey(product => product.Id);
        builder.Property(product => product.Id).HasColumnName("id");
        builder.Property(product => product.Name).HasColumnName("name").HasMaxLength(200).IsRequired();
        builder.Property(product => product.Description).HasColumnName("description").HasMaxLength(12000).IsRequired();
        builder.Property(product => product.ImagePath).HasColumnName("image_path").HasMaxLength(1024);
        builder.Property(product => product.BrandId).HasColumnName("brand_id");
        builder.Property(product => product.CosmeticTypeId).HasColumnName("cosmetic_type_id");
        builder.Property(product => product.IsVisible).HasColumnName("is_visible").HasDefaultValue(false);
        builder.Property(product => product.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.Property(product => product.UpdatedAt).HasColumnName("updated_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.Property(product => product.Version).IsRowVersion();
        builder.HasOne(product => product.Brand).WithMany(brand => brand.Products)
            .HasForeignKey(product => product.BrandId).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(product => product.CosmeticType).WithMany(type => type.Products)
            .HasForeignKey(product => product.CosmeticTypeId).OnDelete(DeleteBehavior.Restrict);
        builder.HasIndex(product => new { product.BrandId, product.CosmeticTypeId })
            .HasDatabaseName("ix_products_brand_type");
        builder.HasIndex(product => product.CosmeticTypeId).HasDatabaseName("ix_products_type");
    }
}

internal sealed class ProductVariantConfiguration : IEntityTypeConfiguration<ProductVariant>
{
    public void Configure(EntityTypeBuilder<ProductVariant> builder)
    {
        builder.ToTable("product_variants", table =>
        {
            table.HasCheckConstraint("ck_product_variants_price", "price_rub >= 0");
            table.HasCheckConstraint("ck_product_variants_volume", "volume IS NULL OR (volume <> '' AND volume = btrim(volume))");
            table.HasCheckConstraint("ck_product_variants_size", "size IS NULL OR (size <> '' AND size = btrim(size))");
            table.HasCheckConstraint("ck_product_variants_shade", "shade IS NULL OR (shade <> '' AND shade = btrim(shade))");
        });
        builder.HasKey(variant => variant.Id);
        builder.Property(variant => variant.Id).HasColumnName("id");
        builder.Property(variant => variant.ProductId).HasColumnName("product_id");
        builder.Property(variant => variant.Volume).HasColumnName("volume").HasMaxLength(64);
        builder.Property(variant => variant.Size).HasColumnName("size").HasMaxLength(64);
        builder.Property(variant => variant.Shade).HasColumnName("shade").HasMaxLength(120);
        builder.Property(variant => variant.PriceRub).HasColumnName("price_rub").HasPrecision(12, 2);
        builder.Property(variant => variant.IsVisible).HasColumnName("is_visible").HasDefaultValue(true);
        builder.HasOne(variant => variant.Product).WithMany(product => product.Variants)
            .HasForeignKey(variant => variant.ProductId).OnDelete(DeleteBehavior.Cascade);
        // Nulls must compare equal so a product cannot get duplicate default variants.
        builder.HasIndex(variant => new { variant.ProductId, variant.Volume, variant.Size, variant.Shade })
            .IsUnique().AreNullsDistinct(false).HasDatabaseName("ux_product_variants_options");
    }
}

internal sealed class ShopUserConfiguration : IEntityTypeConfiguration<ShopUser>
{
    public void Configure(EntityTypeBuilder<ShopUser> builder)
    {
        builder.ToTable("users", table =>
        {
            table.HasCheckConstraint("ck_users_telegram_id", "telegram_id > 0");
            table.HasCheckConstraint("ck_users_role", "role IN ('Customer', 'Admin')");
        });
        builder.HasKey(user => user.Id);
        builder.Property(user => user.Id).HasColumnName("id");
        builder.Property(user => user.TelegramId).HasColumnName("telegram_id");
        builder.Property(user => user.Role).HasColumnName("role").HasConversion<string>()
            .HasMaxLength(16).HasDefaultValue(UserRole.Customer);
        builder.Property(user => user.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.HasIndex(user => user.TelegramId).IsUnique().HasDatabaseName("ux_users_telegram_id");
    }
}

internal sealed class SaveOperationConfiguration : IEntityTypeConfiguration<SaveOperation>
{
    public void Configure(EntityTypeBuilder<SaveOperation> builder)
    {
        builder.ToTable("save_operations", table =>
            table.HasCheckConstraint("ck_save_operations_kind", $"kind IN ('{SaveOperation.CreateProduct}', '{SaveOperation.UpdateProduct}')"));
        // The key is looked up only together with its owner, so one admin can never read another admin's result.
        builder.HasKey(operation => new { operation.OwnerTelegramId, operation.Key }).HasName("pk_save_operations");
        builder.Property(operation => operation.OwnerTelegramId).HasColumnName("owner_telegram_id");
        builder.Property(operation => operation.Key).HasColumnName("key");
        builder.Property(operation => operation.Kind).HasColumnName("kind").HasMaxLength(32).IsRequired();
        builder.Property(operation => operation.Fingerprint).HasColumnName("fingerprint").HasMaxLength(32).IsRequired();
        builder.Property(operation => operation.ProductId).HasColumnName("product_id");
        builder.Property(operation => operation.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.HasOne<Product>().WithMany().HasForeignKey(operation => operation.ProductId).OnDelete(DeleteBehavior.Cascade);
        builder.HasIndex(operation => operation.CreatedAt).HasDatabaseName("ix_save_operations_created_at");
    }
}
