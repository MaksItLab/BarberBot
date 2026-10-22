using CosmeticsShop.Application.Common;
using Microsoft.AspNetCore.Diagnostics;

namespace CosmeticsShop.Api.Errors;

public sealed class ShopExceptionHandler : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(HttpContext context, Exception exception, CancellationToken cancellationToken)
    {
        if (exception is not ShopFailureException failure) return false;
        var status = failure.Kind switch { ShopFailureKind.Invalid => 400, ShopFailureKind.Conflict => 409, ShopFailureKind.NotFound => 404, _ => 500 };
        await Results.Problem(statusCode: status, title: failure.Message).ExecuteAsync(context);
        return true;
    }
}
