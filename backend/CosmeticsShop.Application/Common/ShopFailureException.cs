namespace CosmeticsShop.Application.Common;

public enum ShopFailureKind { Invalid, Conflict, NotFound, KeyReused }

public sealed class ShopFailureException(ShopFailureKind kind, string message) : Exception(message)
{
    public ShopFailureKind Kind { get; } = kind;
}

public static class InputRules
{
    public static string Required(string? value, int maxLength, string label)
    {
        var result = Optional(value, maxLength, label);
        return result ?? throw new ShopFailureException(ShopFailureKind.Invalid, $"Заполните поле «{label}».");
    }

    public static string? Optional(string? value, int maxLength, string label)
    {
        var result = value?.Trim();
        if (string.IsNullOrEmpty(result)) return null;
        if (result.Contains('\0')) throw new ShopFailureException(ShopFailureKind.Invalid, $"Поле «{label}» содержит недопустимый символ.");
        if (result.Length > maxLength) throw new ShopFailureException(ShopFailureKind.Invalid, $"Поле «{label}» — не более {maxLength} символов.");
        return result;
    }
}
