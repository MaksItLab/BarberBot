using Microsoft.Net.Http.Headers;

namespace CosmeticsShop.Api.Hosting;

public static class PrivateResponses
{
    /// <summary>
    /// U01: admin and login answers depend on the Telegram user, so no browser, tunnel or proxy cache may keep them.
    /// Set on start, because error handling may clear headers that were added earlier. The public catalog is left as is.
    /// </summary>
    public static IApplicationBuilder UsePrivateResponsesNoStore(this IApplicationBuilder app) =>
        app.Use((context, next) =>
        {
            var path = context.Request.Path;
            if (path.StartsWithSegments("/api/admin") || path.StartsWithSegments("/api/auth"))
                context.Response.OnStarting(() =>
                {
                    context.Response.Headers[HeaderNames.CacheControl] = "no-store";
                    return Task.CompletedTask;
                });
            return next(context);
        });
}
