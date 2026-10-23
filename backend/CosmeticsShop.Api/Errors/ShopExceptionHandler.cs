using System.Data.Common;
using CosmeticsShop.Api.Hosting;
using CosmeticsShop.Application.Common;
using Microsoft.AspNetCore.Diagnostics;

namespace CosmeticsShop.Api.Errors;

public sealed class ShopExceptionHandler : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(HttpContext context, Exception exception, CancellationToken cancellationToken)
    {
        if (exception is ShopFailureException failure)
        {
            var (status, code) = failure.Kind switch
            {
                ShopFailureKind.Invalid => (400, ShopErrorCodes.ValidationFailed),
                ShopFailureKind.Conflict => (409, ShopErrorCodes.Conflict),
                ShopFailureKind.NotFound => (404, ShopErrorCodes.NotFound),
                ShopFailureKind.KeyReused => (422, ShopErrorCodes.IdempotencyKeyReused),
                _ => (500, ShopErrorCodes.InternalError)
            };
            if (failure is { Kind: ShopFailureKind.Invalid, Field: { } field })
                // ValidationProblemDetails: the title stays readable for older clients, errors point at the field.
                await Results.ValidationProblem(new Dictionary<string, string[]> { [field] = [failure.Message] },
                    title: failure.Message, extensions: new Dictionary<string, object?> { ["code"] = code }).ExecuteAsync(context);
            else await Problem(context, status, failure.Message, code, failure.Current);
            return true;
        }
        if (IsDatabaseUnavailable(exception))
        {
            // A write may have reached the database before the connection failed, so its outcome is unknown.
            var title = RequestDiagnostics.IsSave(context.Request)
                ? "Нет связи с базой данных. Проверьте, сохранились ли изменения, прежде чем повторять."
                : "База данных временно недоступна. Повторите попытку позже.";
            await Problem(context, 503, title, ShopErrorCodes.DatabaseUnavailable);
            return true;
        }
        return false;
    }

    private static bool IsDatabaseUnavailable(Exception exception)
    {
        for (Exception? current = exception; current is not null; current = current.InnerException)
            if (current is DbException { IsTransient: true } or TimeoutException) return true;
        return false;
    }

    private static Task Problem(HttpContext context, int status, string title, string code, object? current = null)
    {
        var extensions = new Dictionary<string, object?> { ["code"] = code };
        if (current is not null) extensions["current"] = current;
        return Results.Problem(statusCode: status, title: title, extensions: extensions).ExecuteAsync(context);
    }
}
