'use strict';

/**
 * Every GraphQL document the dashboard sends to Railway lives in this one file,
 * so all of them can be checked against Railway's public schema in one go.
 * The operation name of each document is also used as `operationName` on the wire.
 */

const DEPLOYMENT_FIELDS = `
      id
      status
      createdAt
      updatedAt
      statusUpdatedAt
      deploymentStopped
      canRedeploy
      canRollback
      url
      staticUrl
      meta`;

module.exports = {
  // --- Reading -------------------------------------------------------------------------

  ProjectToken: `
    query ProjectToken {
      projectToken { projectId environmentId }
    }`,

  Overview: `
    query Overview($projectId: String!, $environmentId: String!) {
      project(id: $projectId) { id name }
      environment(id: $environmentId, projectId: $projectId) {
        id
        name
        serviceInstances {
          edges {
            node {
              id
              serviceId
              serviceName
              deletedAt
              source { repo image }
              startCommand
              restartPolicyType
              cronSchedule
              numReplicas
              domains {
                serviceDomains { domain }
                customDomains { domain }
              }
              latestDeployment {${DEPLOYMENT_FIELDS}
              }
              activeDeployments { id status createdAt }
            }
          }
        }
      }
    }`,

  Volumes: `
    query Volumes($projectId: String!, $environmentId: String!) {
      environment(id: $environmentId, projectId: $projectId) {
        volumeInstances {
          edges {
            node {
              id
              serviceId
              mountPath
              currentSizeMB
              sizeMB
              state
              volume { id name }
            }
          }
        }
      }
    }`,

  ServiceInstanceDetail: `
    query ServiceInstanceDetail($serviceId: String!, $environmentId: String!) {
      serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
        id
        serviceId
        serviceName
        source { repo image }
        builder
        buildCommand
        startCommand
        rootDirectory
        dockerfilePath
        cronSchedule
        healthcheckPath
        healthcheckTimeout
        restartPolicyType
        restartPolicyMaxRetries
        numReplicas
        region
        sleepApplication
      }
    }`,

  Deployments: `
    query Deployments($projectId: String!, $environmentId: String!, $serviceId: String!, $first: Int) {
      deployments(
        first: $first
        input: { projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId }
      ) {
        edges {
          node {${DEPLOYMENT_FIELDS}
          }
        }
      }
    }`,

  DeploymentLogs: `
    query DeploymentLogs($deploymentId: String!, $limit: Int, $filter: String) {
      deploymentLogs(deploymentId: $deploymentId, limit: $limit, filter: $filter) {
        timestamp
        message
        severity
      }
    }`,

  BuildLogs: `
    query BuildLogs($deploymentId: String!, $limit: Int, $filter: String) {
      buildLogs(deploymentId: $deploymentId, limit: $limit, filter: $filter) {
        timestamp
        message
        severity
      }
    }`,

  Variables: `
    query Variables($projectId: String!, $environmentId: String!, $serviceId: String, $unrendered: Boolean) {
      variables(
        projectId: $projectId
        environmentId: $environmentId
        serviceId: $serviceId
        unrendered: $unrendered
      )
    }`,

  VariablesRendered: `
    query VariablesRendered($projectId: String!, $environmentId: String!, $serviceId: String!) {
      variablesForServiceDeployment(
        projectId: $projectId
        environmentId: $environmentId
        serviceId: $serviceId
      )
    }`,

  // --- Bot actions ---------------------------------------------------------------------

  DeploymentRestart: `
    mutation DeploymentRestart($id: String!) {
      deploymentRestart(id: $id)
    }`,

  DeploymentStop: `
    mutation DeploymentStop($id: String!) {
      deploymentStop(id: $id)
    }`,

  DeploymentCancel: `
    mutation DeploymentCancel($id: String!) {
      deploymentCancel(id: $id)
    }`,

  DeploymentRemove: `
    mutation DeploymentRemove($id: String!) {
      deploymentRemove(id: $id)
    }`,

  DeploymentRollback: `
    mutation DeploymentRollback($id: String!) {
      deploymentRollback(id: $id)
    }`,

  DeploymentRedeploy: `
    mutation DeploymentRedeploy($id: String!) {
      deploymentRedeploy(id: $id) { id status }
    }`,

  ServiceInstanceRedeploy: `
    mutation ServiceInstanceRedeploy($serviceId: String!, $environmentId: String!) {
      serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
    }`,

  ServiceInstanceDeploy: `
    mutation ServiceInstanceDeploy($serviceId: String!, $environmentId: String!) {
      serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
    }`,

  // --- Changing things -----------------------------------------------------------------

  VariableUpsert: `
    mutation VariableUpsert($input: VariableUpsertInput!) {
      variableUpsert(input: $input)
    }`,

  VariableDelete: `
    mutation VariableDelete($input: VariableDeleteInput!) {
      variableDelete(input: $input)
    }`,

  VariableBulk: `
    mutation VariableBulk($input: VariableCollectionUpsertInput!) {
      variableCollectionUpsert(input: $input)
    }`,

  ServiceInstanceUpdate: `
    mutation ServiceInstanceUpdate($serviceId: String!, $environmentId: String, $input: ServiceInstanceUpdateInput!) {
      serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
    }`,

  ServiceRename: `
    mutation ServiceRename($id: String!, $input: ServiceUpdateInput!) {
      serviceUpdate(id: $id, input: $input) { id name }
    }`,
};
