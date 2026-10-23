using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace CosmeticsShop.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class SaveOperations : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "save_operations",
                columns: table => new
                {
                    owner_telegram_id = table.Column<long>(type: "bigint", nullable: false),
                    key = table.Column<Guid>(type: "uuid", nullable: false),
                    kind = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    fingerprint = table.Column<byte[]>(type: "bytea", maxLength: 32, nullable: false),
                    product_id = table.Column<long>(type: "bigint", nullable: true),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_save_operations", x => new { x.owner_telegram_id, x.key });
                    table.CheckConstraint("ck_save_operations_kind", "kind IN ('product.create', 'product.update')");
                    table.ForeignKey(
                        name: "FK_save_operations_products_product_id",
                        column: x => x.product_id,
                        principalTable: "products",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_save_operations_created_at",
                table: "save_operations",
                column: "created_at");

            migrationBuilder.CreateIndex(
                name: "IX_save_operations_product_id",
                table: "save_operations",
                column: "product_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "save_operations");
        }
    }
}
