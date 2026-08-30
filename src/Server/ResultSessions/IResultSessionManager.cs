// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

namespace Kusto.Vscode;

public interface IResultSessionManager : IDisposable
{
    Task<StartResultSessionResult> StartAsync(StartResultSessionParams parameters);

    Task<CancelResultSessionOperationResult> CancelAsync(
        CancelResultSessionOperationParams parameters);

    Task<ResultSessionStatus> GetStatusAsync(
        GetResultSessionStatusParams parameters);

    Task<SetResultSessionViewResult> SetViewAsync(
        SetResultSessionViewParams parameters,
        CancellationToken cancellationToken);

    Task<ResultSessionPage> GetPageAsync(
        GetResultSessionPageParams parameters,
        CancellationToken cancellationToken);

    Task<ResultSessionProjection> GetProjectionAsync(
        GetResultSessionProjectionParams parameters,
        CancellationToken cancellationToken);

    Task<CreateResultSessionContinuationResult> CreateContinuationAsync(
        CreateResultSessionContinuationParams parameters,
        CancellationToken cancellationToken);

    Task<DisposeResultSessionResult> DisposeAsync(
        DisposeResultSessionParams parameters);
}
