using System.Diagnostics;

namespace CosmeticsShop.Api.Hosting;

/// <summary>Stable machine-readable codes returned in the "code" field of every API problem response.</summary>
public static class ShopErrorCodes
{
    public const string AuthMissing = "auth_missing";
    public const string AuthInvalid = "auth_invalid";
    public const string AuthExpired = "auth_expired";
    public const string UserNotFound = "user_not_found";
    public const string Forbidden = "forbidden";
    public const string SecureTransportUnavailable = "secure_transport_unavailable";
    public const string ValidationFailed = "validation_failed";
    public const string NotFound = "not_found";
    public const string Conflict = "conflict";
    public const string DatabaseUnavailable = "database_unavailable";
    public const string ServiceUnavailable = "service_unavailable";
    public const string InternalError = "internal_error";
    public const string RequestFailed = "request_failed";
    public const string ClientAborted = "client_aborted";
}

public static class RequestDiagnostics
{
    public const string RequestIdHeader = "X-Request-Id";
    private static readonly object ErrorCodeKey = new();
    private static readonly object AuthenticationTimeKey = new();

    /// <summary>The same identifier is sent to the client, written to the log line and matches ProblemDetails.traceId.</summary>
    public static string RequestId(HttpContext context) => Activity.Current?.TraceId.ToHexString() ?? context.TraceIdentifier;

    public static void SetErrorCode(HttpContext context, string code) => context.Items[ErrorCodeKey] = code;

    public static void RecordAuthenticationTime(HttpContext context, TimeSpan elapsed) => context.Items[AuthenticationTimeKey] = elapsed;

    public static IServiceCollection AddShopProblemDetails(this IServiceCollection services) =>
        services.AddProblemDetails(options => options.CustomizeProblemDetails = context =>
        {
            var http = context.HttpContext;
            var code = context.ProblemDetails.Extensions.TryGetValue("code", out var explicitCode) && explicitCode is string value
                ? value
                : http.Items[ErrorCodeKey] as string ?? DefaultCode(context.ProblemDetails.Status ?? http.Response.StatusCode);
            SetErrorCode(http, code);
            context.ProblemDetails.Extensions["code"] = code;
            context.ProblemDetails.Extensions["requestId"] = RequestId(http);
        });

    /// <summary>
    /// Adds the request identifier header and writes one log line per API request.
    /// The line contains only the route template, status, code and durations: never headers,
    /// query values, request bodies, Telegram initData or user identifiers.
    /// </summary>
    public static IApplicationBuilder UseRequestDiagnostics(this IApplicationBuilder app)
    {
        var logger = app.ApplicationServices.GetRequiredService<ILoggerFactory>().CreateLogger("CosmeticsShop.Requests");
        return app.Use(async (context, next) =>
        {
            // Set on start, because error handling may clear headers that were added earlier.
            context.Response.OnStarting(() =>
            {
                context.Response.Headers[RequestIdHeader] = RequestId(context);
                return Task.CompletedTask;
            });
            var started = Stopwatch.GetTimestamp();
            // Read the route now: the exception handler clears the endpoint before re-executing the pipeline.
            var route = (context.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText;
            try { await next(context); }
            finally
            {
                var path = context.Request.Path;
                if (path.StartsWithSegments("/api") && !path.StartsWithSegments("/api/health"))
                    Log(logger, context, route ?? (context.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText ?? "unmatched",
                        Stopwatch.GetElapsedTime(started));
            }
        });
    }

    private static void Log(ILogger logger, HttpContext context, string route, TimeSpan elapsed)
    {
        var status = context.Response.StatusCode;
        var code = context.RequestAborted.IsCancellationRequested
            ? ShopErrorCodes.ClientAborted
            : context.Items[ErrorCodeKey] as string ?? (status >= 400 ? DefaultCode(status) : "ok");
        var authentication = context.Items[AuthenticationTimeKey] is TimeSpan auth ? Math.Round(auth.TotalMilliseconds, 1) : (double?)null;
        logger.Log(status >= 500 || code == ShopErrorCodes.ClientAborted ? LogLevel.Warning : LogLevel.Information,
            "operation={Operation} method={Method} route={Route} status={Status} code={Code} elapsed_ms={ElapsedMs} auth_ms={AuthMs} request={RequestId}",
            Operation(context.Request), context.Request.Method, route, status, code,
            Math.Round(elapsed.TotalMilliseconds, 1), authentication, RequestId(context));
    }

    private static string Operation(HttpRequest request) =>
        HttpMethods.IsPost(request.Method) && request.Path.Equals("/api/auth/telegram") ? "login"
        : IsSave(request) ? "save"
        : "read";

    /// <summary>A business write whose outcome is unknown when the response is lost. Login only registers the customer once.</summary>
    public static bool IsSave(HttpRequest request) =>
        request.Path.StartsWithSegments("/api/admin") && !HttpMethods.IsGet(request.Method);

    private static string DefaultCode(int status) => status switch
    {
        400 => ShopErrorCodes.ValidationFailed,
        401 => ShopErrorCodes.AuthInvalid,
        403 => ShopErrorCodes.Forbidden,
        404 => ShopErrorCodes.NotFound,
        409 => ShopErrorCodes.Conflict,
        503 => ShopErrorCodes.ServiceUnavailable,
        >= 500 => ShopErrorCodes.InternalError,
        _ => ShopErrorCodes.RequestFailed
    };
}
