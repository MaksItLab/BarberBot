using System.Globalization;
using System.Text.RegularExpressions;
using CosmeticsShop.Application.Common;
using CosmeticsShop.Contracts.Admin;

namespace CosmeticsShop.Application.Admin;

public sealed record ValidVariant(long? Id, string? Volume, string? Size, string? Shade, decimal PriceRub, bool IsVisible);
public sealed record ValidProduct(string Name, string Description, long BrandId, long TypeId,
    string? ImagePath, bool IsVisible, IReadOnlyList<ValidVariant> Variants);

public static partial class ProductRules
{
    /// <summary>Stops at the first invalid field and names it by its request path, so the form can mark it.</summary>
    public static ValidProduct Validate(SaveProductRequest request)
    {
        var name = InputRules.Required(request.Name, 200, "Название товара", "name");
        var description = InputRules.Required(request.Description, 12000, "Описание товара", "description");
        var image = InputRules.Optional(request.ImagePath, 1024, "Изображение", "imagePath");
        if (image is not null && !ImagePattern().IsMatch(image)) Invalid("Укажите локальный путь /images/ к PNG, JPEG, WebP или AVIF.", "imagePath");
        var brand = Id(request.BrandId, "Бренд", "brandId"); var type = Id(request.TypeId, "Тип косметики", "typeId");
        if (request.Variants is null || request.Variants.Count > 100) Invalid("Передайте список не более 100 вариантов.", "variants");
        var variants = new List<ValidVariant>();
        foreach (var (value, index) in request.Variants!.Select((value, index) => (value, index)))
        {
            var path = $"variants[{index}]";
            if (value is null) Invalid("Вариант не может быть пустым.", path);
            if (value!.PriceRub is not { } price || price < 0 || price > 9_999_999_999.99m || decimal.Round(price, 2) != price)
                Invalid("Цена обязательна: от 0 до 9 999 999 999,99 ₽, не более двух знаков после запятой.", $"{path}.priceRub");
            variants.Add(new(value.Id is null ? null : Id(value.Id, "Вариант", $"{path}.id"),
                InputRules.Optional(value.Volume, 64, "Объём", $"{path}.volume"), InputRules.Optional(value.Size, 64, "Размер", $"{path}.size"),
                InputRules.Optional(value.Shade, 120, "Оттенок", $"{path}.shade"), value.PriceRub!.Value, value.IsVisible));
        }
        if (variants.Select(value => (value.Volume, value.Size, value.Shade)).Distinct().Count() != variants.Count)
            throw new ShopFailureException(ShopFailureKind.Conflict, "У товара уже есть вариант с такими характеристиками.");
        var ids = variants.Where(value => value.Id is not null).Select(value => value.Id).ToArray();
        if (ids.Distinct().Count() != ids.Length) Invalid("Вариант указан несколько раз.", "variants");
        if (request.IsVisible && !variants.Any(value => value.IsVisible)) Invalid("Для публикации нужен хотя бы один видимый вариант. Либо скройте товар.", "isVisible");
        return new(name, description, brand, type, image, request.IsVisible, variants);
    }

    private static long Id(string? value, string label, string field) => long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var id) && id > 0
        ? id : throw new ShopFailureException(ShopFailureKind.Invalid, $"Выберите корректное значение: {label}.", field: field);
    private static void Invalid(string message, string field) => throw new ShopFailureException(ShopFailureKind.Invalid, message, field: field);
    [GeneratedRegex(@"\A/images/[a-zA-Z0-9_/-]+\.(png|jpe?g|webp|avif)\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ImagePattern();
}
