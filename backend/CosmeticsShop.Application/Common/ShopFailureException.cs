namespace CosmeticsShop.Application.Common;

public enum ShopFailureKind { Invalid, Conflict, NotFound, KeyReused }

/// <param name="current">For a version conflict: the current state, so the client can show what changed without losing its input.</param>
/// <param name="field">For invalid input: the request path of the field, such as <c>name</c> or <c>variants[1].priceRub</c>.</param>
public sealed class ShopFailureException(ShopFailureKind kind, string message, object? current = null, string? field = null) : Exception(message)
{
    public ShopFailureKind Kind { get; } = kind;
    public object? Current { get; } = current;
    public string? Field { get; } = field;
}

public static class InputRules
{
    public static string Required(string? value, int maxLength, string label, string? field = null)
    {
        var result = Optional(value, maxLength, label, field);
        return result ?? throw new ShopFailureException(ShopFailureKind.Invalid, $"Заполните поле «{label}».", field: field);
    }

    public static string? Optional(string? value, int maxLength, string label, string? field = null)
    {
        var result = value?.Trim();
        if (string.IsNullOrEmpty(result)) return null;
        if (result.Contains('\0')) throw new ShopFailureException(ShopFailureKind.Invalid, $"Поле «{label}» содержит недопустимый символ.", field: field);
        if (result.Length > maxLength) throw new ShopFailureException(ShopFailureKind.Invalid, $"Поле «{label}» — не более {maxLength} символов.", field: field);
        return result;
    }
}
