using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace CosmeticsShop.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class InitialCatalog : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "brands",
                columns: table => new
                {
                    id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    name = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: false),
                    description = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_brands", x => x.id);
                    table.CheckConstraint("ck_brands_name", "name <> '' AND name = btrim(name)");
                });

            migrationBuilder.CreateTable(
                name: "cosmetic_types",
                columns: table => new
                {
                    id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    name = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_cosmetic_types", x => x.id);
                    table.CheckConstraint("ck_cosmetic_types_name", "name <> '' AND name = btrim(name)");
                });

            migrationBuilder.CreateTable(
                name: "users",
                columns: table => new
                {
                    id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    telegram_id = table.Column<long>(type: "bigint", nullable: false),
                    role = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false, defaultValue: "Customer"),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_users", x => x.id);
                    table.CheckConstraint("ck_users_role", "role IN ('Customer', 'Admin')");
                    table.CheckConstraint("ck_users_telegram_id", "telegram_id > 0");
                });

            migrationBuilder.CreateTable(
                name: "products",
                columns: table => new
                {
                    id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    description = table.Column<string>(type: "character varying(12000)", maxLength: 12000, nullable: false),
                    image_path = table.Column<string>(type: "character varying(1024)", maxLength: 1024, nullable: true),
                    brand_id = table.Column<long>(type: "bigint", nullable: false),
                    cosmetic_type_id = table.Column<long>(type: "bigint", nullable: false),
                    is_visible = table.Column<bool>(type: "boolean", nullable: false, defaultValue: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_products", x => x.id);
                    table.CheckConstraint("ck_products_description", "btrim(description) <> ''");
                    table.CheckConstraint("ck_products_name", "name <> '' AND name = btrim(name)");
                    table.ForeignKey(
                        name: "FK_products_brands_brand_id",
                        column: x => x.brand_id,
                        principalTable: "brands",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_products_cosmetic_types_cosmetic_type_id",
                        column: x => x.cosmetic_type_id,
                        principalTable: "cosmetic_types",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "product_variants",
                columns: table => new
                {
                    id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    product_id = table.Column<long>(type: "bigint", nullable: false),
                    volume = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    size = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    shade = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: true),
                    price_rub = table.Column<decimal>(type: "numeric(12,2)", precision: 12, scale: 2, nullable: false),
                    is_visible = table.Column<bool>(type: "boolean", nullable: false, defaultValue: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_product_variants", x => x.id);
                    table.CheckConstraint("ck_product_variants_price", "price_rub >= 0");
                    table.CheckConstraint("ck_product_variants_shade", "shade IS NULL OR (shade <> '' AND shade = btrim(shade))");
                    table.CheckConstraint("ck_product_variants_size", "size IS NULL OR (size <> '' AND size = btrim(size))");
                    table.CheckConstraint("ck_product_variants_volume", "volume IS NULL OR (volume <> '' AND volume = btrim(volume))");
                    table.ForeignKey(
                        name: "FK_product_variants_products_product_id",
                        column: x => x.product_id,
                        principalTable: "products",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ux_brands_name",
                table: "brands",
                column: "name",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ux_cosmetic_types_name",
                table: "cosmetic_types",
                column: "name",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ux_product_variants_options",
                table: "product_variants",
                columns: new[] { "product_id", "volume", "size", "shade" },
                unique: true)
                .Annotation("Npgsql:NullsDistinct", false);

            migrationBuilder.CreateIndex(
                name: "ix_products_brand_type",
                table: "products",
                columns: new[] { "brand_id", "cosmetic_type_id" });

            migrationBuilder.CreateIndex(
                name: "ix_products_type",
                table: "products",
                column: "cosmetic_type_id");

            migrationBuilder.CreateIndex(
                name: "ux_users_telegram_id",
                table: "users",
                column: "telegram_id",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "product_variants");

            migrationBuilder.DropTable(
                name: "users");

            migrationBuilder.DropTable(
                name: "products");

            migrationBuilder.DropTable(
                name: "brands");

            migrationBuilder.DropTable(
                name: "cosmetic_types");
        }
    }
}
