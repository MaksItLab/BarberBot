using CosmeticsShop.Application.Catalog;
using CosmeticsShop.Domain;
using CosmeticsShop.Infrastructure.Catalog;
using Microsoft.EntityFrameworkCore;

namespace CosmeticsShop.Api.IntegrationTests;

public sealed class CatalogReaderTests(PostgresFixture fixture) : IClassFixture<PostgresFixture>
{
    [Fact]
    public async Task FiltersCombineAndUnknownFilterIsEmpty()
    {
        await using var db = fixture.CreateContext();
        await using var transaction = await db.Database.BeginTransactionAsync();
        var first = NewProduct("Первый");
        var second = NewProduct("Второй");
        var third = NewProduct("Третий");
        second.Brand = first.Brand;
        third.CosmeticType = first.CosmeticType;
        db.Products.AddRange(first, second, third);
        await db.SaveChangesAsync();
        var reader = new CatalogReader(db);
        Assert.Equal(3, (await reader.GetProductsAsync(new(null, null), default)).Items.Count);
        Assert.Equal(2, (await reader.GetProductsAsync(new(first.BrandId, null), default)).Items.Count);
        Assert.Equal(2, (await reader.GetProductsAsync(new(null, first.CosmeticTypeId), default)).Items.Count);
        Assert.Equal(first.Id.ToString(), Assert.Single((await reader.GetProductsAsync(new(first.BrandId, first.CosmeticTypeId), default)).Items).Id);
        Assert.Empty((await reader.GetProductsAsync(new(long.MaxValue, null), default)).Items);
    }

    [Fact]
    public async Task HiddenProductsAndVariantsDoNotLeakOrInfluencePriceAndFilters()
    {
        await using var db = fixture.CreateContext();
        await using var transaction = await db.Database.BeginTransactionAsync();
        var visible = NewProduct("Видимый");
        visible.Variants.Add(new ProductVariant { Volume = "50 мл", PriceRub = 1m, IsVisible = false });
        visible.Variants.Add(new ProductVariant { Volume = "100 мл", PriceRub = 400m });
        var hidden = NewProduct("Скрытый"); hidden.IsVisible = false;
        var empty = NewProduct("Нет вариантов"); empty.Variants.Clear();
        var hiddenVariants = NewProduct("Скрыты варианты"); hiddenVariants.Variants.Single().IsVisible = false;
        db.Products.AddRange(visible, hidden, empty, hiddenVariants);
        await db.SaveChangesAsync();
        var reader = new CatalogReader(db);
        var item = Assert.Single((await reader.GetProductsAsync(new(null, null), default)).Items);
        Assert.Equal(199.99m, item.PriceRub);
        Assert.True(item.HasPriceRange);
        Assert.Equal(visible.BrandId.ToString(), Assert.Single(await reader.GetBrandsAsync(default)).Id);
        Assert.Equal(visible.CosmeticTypeId.ToString(), Assert.Single(await reader.GetTypesAsync(default)).Id);
    }

    [Fact]
    public async Task SamePricesHaveNoFromPrefixAndPaginationHasNoDuplicates()
    {
        await using var db = fixture.CreateContext();
        await using var transaction = await db.Database.BeginTransactionAsync();
        var products = Enumerable.Range(1, 3).Select(index => NewProduct($"Товар {index}")).ToArray();
        products[0].Variants.Add(new ProductVariant { Shade = "01", PriceRub = 199.99m });
        db.Products.AddRange(products);
        await db.SaveChangesAsync();
        var reader = new CatalogReader(db);
        var first = await reader.GetProductsAsync(new(null, null, 1, 2), default);
        var second = await reader.GetProductsAsync(new(null, null, 2, 2), default);
        Assert.True(first.HasMore); Assert.False(second.HasMore);
        Assert.False(first.Items[0].HasPriceRange);
        Assert.Equal(products.Select(product => product.Id.ToString()).OrderBy(long.Parse), first.Items.Concat(second.Items).Select(item => item.Id));
        Assert.Empty((await reader.GetProductsAsync(new(null, null, 3, 2), default)).Items);
    }

    [Fact]
    public async Task CancelledQueryDoesNotContinueReading()
    {
        await using var db = fixture.CreateContext();
        var reader = new CatalogReader(db);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => reader.GetProductsAsync(new(null, null), cancellation.Token));
    }

    [Fact]
    public async Task DetailsContainBrandAndRealVisibleVariantsSortedByPriceThenId()
    {
        await using var db = fixture.CreateContext();
        await using var transaction = await db.Database.BeginTransactionAsync();
        var product = NewProduct("Крем");
        product.Description = "<script>Не HTML</script>";
        product.Brand.Description = "О бренде";
        product.Variants.Add(new ProductVariant { Volume = "50 мл", Shade = "02", PriceRub = 99.99m });
        product.Variants.Add(new ProductVariant { Volume = "100 мл", Size = "M", PriceRub = 99.99m });
        product.Variants.Add(new ProductVariant { Shade = "Скрытый", PriceRub = 0, IsVisible = false });
        db.Products.Add(product);
        await db.SaveChangesAsync();
        var reader = new CatalogReader(db);
        var result = await reader.GetProductAsync(product.Id, default);
        Assert.NotNull(result);
        Assert.Equal(product.Description, result.Description);
        Assert.Equal("О бренде", result.BrandDescription);
        Assert.Equal(product.CosmeticType.Name, result.TypeName);
        Assert.Equal(3, result.Variants.Count);
        Assert.Equal([99.99m, 99.99m, 199.99m], result.Variants.Select(variant => variant.PriceRub));
        Assert.Equal("50 мл", result.Variants[0].Volume);
        Assert.Equal("M", result.Variants[1].Size);
        Assert.Equal((await reader.GetProductsAsync(new(null, null), default)).Items[0].PriceRub, result.Variants[0].PriceRub);
    }

    [Fact]
    public async Task HiddenMissingAndVariantlessProductsHaveNoPublicDetails()
    {
        await using var db = fixture.CreateContext();
        await using var transaction = await db.Database.BeginTransactionAsync();
        var hidden = NewProduct("Скрытый"); hidden.IsVisible = false;
        var empty = NewProduct("Без вариантов"); empty.Variants.Clear();
        var hiddenVariant = NewProduct("Скрытый вариант"); hiddenVariant.Variants.Single().IsVisible = false;
        db.Products.AddRange(hidden, empty, hiddenVariant);
        await db.SaveChangesAsync();
        var reader = new CatalogReader(db);
        foreach (var id in new[] { hidden.Id, empty.Id, hiddenVariant.Id, long.MaxValue })
            Assert.Null(await reader.GetProductAsync(id, default));
    }

    private static Product NewProduct(string name) => new()
    {
        Name = name, Description = "Описание", IsVisible = true,
        Brand = new Brand { Name = Guid.NewGuid().ToString("N") },
        CosmeticType = new CosmeticType { Name = Guid.NewGuid().ToString("N") },
        Variants = [new ProductVariant { PriceRub = 199.99m }]
    };
}
