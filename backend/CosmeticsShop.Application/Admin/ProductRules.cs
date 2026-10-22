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
    public static ValidProduct Validate(SaveProductRequest request)
    {
        var name = InputRules.Required(request.Name, 200, "Название товара");
        var description = InputRules.Required(request.Description, 12000, "Описание товара");
        var image = InputRules.Optional(request.ImagePath, 1024, "Изображение");
        if (image is not null && !ImagePattern().IsMatch(image)) Invalid("Укажите локальный путь /images/ к PNG, JPEG, WebP или AVIF.");
        var brand = Id(request.BrandId, "Бренд"); var type = Id(request.TypeId, "Тип косметики");
        if (request.Variants is null || request.Variants.Count > 100) Invalid("Передайте список не более 100 вариантов.");
        var variants = new List<ValidVariant>();
        foreach (var value in request.Variants!)
        {
            if (value is null) Invalid("Вариант не может быть пустым.");
            if (value!.PriceRub is not { } price || price < 0 || price > 9_999_999_999.99m || decimal.Round(price, 2) != price)
                Invalid("Цена обязательна: от 0 до 9 999 999 999,99 ₽, не более двух знаков после запятой.");
            variants.Add(new(value.Id is null ? null : Id(value.Id, "Вариант"),
                InputRules.Optional(value.Volume, 64, "Объём"), InputRules.Optional(value.Size, 64, "Размер"),
                InputRules.Optional(value.Shade, 120, "Оттенок"), value.PriceRub!.Value, value.IsVisible));
        }
        if (variants.Select(value => (value.Volume, value.Size, value.Shade)).Distinct().Count() != variants.Count)
            throw new ShopFailureException(ShopFailureKind.Conflict, "У товара уже есть вариант с такими характеристиками.");
        var ids = variants.Where(value => value.Id is not null).Select(value => value.Id).ToArray();
        if (ids.Distinct().Count() != ids.Length) Invalid("Вариант указан несколько раз.");
        if (request.IsVisible && !variants.Any(value => value.IsVisible)) Invalid("Для публикации нужен хотя бы один видимый вариант. Либо скройте товар.");
        return new(name, description, brand, type, image, request.IsVisible, variants);
    }

    private static long Id(string? value, string label) => long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var id) && id > 0
        ? id : throw new ShopFailureException(ShopFailureKind.Invalid, $"Выберите корректное значение: {label}.");
    private static void Invalid(string message) => throw new ShopFailureException(ShopFailureKind.Invalid, message);
    [GeneratedRegex(@"\A/images/[a-zA-Z0-9_/-]+\.(png|jpe?g|webp|avif)\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ImagePattern();
}
