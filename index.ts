import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as k8s from "@pulumi/kubernetes";
import * as eks from "@pulumi/eks";

// Set a variable name to be used for all resources
const my_name = `eks-ng-issue`;

// **************************************************************
// *******                  SETUP ENV                  **********
// **************************************************************

// Create VPC.
const myvpc = new awsx.ec2.Vpc(`${my_name}-vpc`, {
  cidrBlock: "10.0.0.0/22",
  numberOfAvailabilityZones: 3,
  natGateways: { strategy: "Single" },
  tags: { Name: `${my_name}-vpc` },
  enableDnsHostnames: true,
  enableDnsSupport: true,
});

export const myvpc_id = myvpc.vpcId;
export const myvpc_public_subnets = myvpc.publicSubnetIds;
export const myvpc_private_subnets = myvpc.privateSubnetIds;

// Create a security group for the eks cluster.
const eksclustersecuritygroup = new aws.ec2.SecurityGroup(
  `${my_name}-eks-cluster-sg`,
  {
    vpcId: myvpc.vpcId,
    revokeRulesOnDelete: true,
    description: "EKS created security group created by code.",
    egress: [
      {
        description: "Allow outbound internet access",
        protocol: "-1",
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ["0.0.0.0/0"],
      },
    ],
    ingress: [
      {
        description: "Ingress to self cluster.  ",
        protocol: "-1",
        fromPort: 0,
        toPort: 0,
        self: true, // This allows us to call the securitygroup itself as a source
      },
    ],
    tags: { Name: `${my_name}-eks-cluster-sg` },
  },
  { dependsOn: myvpc }
);

export const eksnodegroupsecuritygroup_name = eksclustersecuritygroup.id;
export const securitygroup_eksnode_id = eksclustersecuritygroup.id;
export const securitygroup_eksnode_name = eksclustersecuritygroup.name;
export const securitygroup_eksnode_vpcid = eksclustersecuritygroup.vpcId;
export const securitygroup_eksnode_tags = eksclustersecuritygroup.tags;

// Create a role for the eks cluster.
const eksRole = new aws.iam.Role(`${my_name}-eksRole`, {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Action: "sts:AssumeRole",
        Effect: "Allow",
        Principal: { Service: "eks.amazonaws.com" },
      },
    ],
  }),
});

// Add the managed policy amazon eks cluster policy to the eks role.
const eksPolicyAttachment = new aws.iam.RolePolicyAttachment(
  `${my_name}-eksPolicyAttachment`,
  {
    policyArn: aws.iam.ManagedPolicy.AmazonEKSClusterPolicy,
    role: eksRole.name,
  }
);

// Add the managed policy amazon eks vpc resource controller policy to the eks role.
const AmazonEKSVPCResourceControllerPolicyAttachment =
  new aws.iam.RolePolicyAttachment("example-AmazonEKSVPCResourceController", {
    policyArn: "arn:aws:iam::aws:policy/AmazonEKSVPCResourceController",
    role: eksRole.name,
  });

// Create an IAM role for the node group.
const nodeRole = new aws.iam.Role(`${my_name}-nodeRole`, {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Action: "sts:AssumeRole",
        Effect: "Allow",
        Principal: { Service: "ec2.amazonaws.com" },
      },
    ],
  }),
});

// Add the managed policy amazon eks worker node policy to the node role.
const example_AmazonEKSWorkerNodePolicy = new aws.iam.RolePolicyAttachment(
  "example-AmazonEKSWorkerNodePolicy",
  {
    policyArn: "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    role: nodeRole.name,
  }
);

// Add the managed policy amazon eks cni policy to the node role.
const example_AmazonEKSCNIPolicy = new aws.iam.RolePolicyAttachment(
  "example-AmazonEKSCNIPolicy",
  {
    policyArn: "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    role: nodeRole.name,
  }
);

// Add the managed policy amazon ec2 container registry read only to the node role.
const example_AmazonEC2ContainerRegistryReadOnly =
  new aws.iam.RolePolicyAttachment(
    "example-AmazonEC2ContainerRegistryReadOnly",
    {
      policyArn: "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
      role: nodeRole.name,
    }
  );

// ########## CREATE EKS CLUSTER ##########
// const mycluster = new aws.eks.Cluster(`${my_name}-eks`, {
//   roleArn: eksRole.arn,
//   version: "1.25",
//   enabledClusterLogTypes: [
//     "api",
//     "audit",
//     "authenticator",
//     "controllerManager",
//     "scheduler",
//   ],
//   vpcConfig: {
//     securityGroupIds: [eksclustersecuritygroup.id],
//     subnetIds: myvpc.publicSubnetIds,
//   },
// });

const mycluster = new eks.Cluster(`${my_name}-eks`, {
  // roleArn: eksRole.arn,
  instanceRoles: [eksRole, nodeRole],
  skipDefaultNodeGroup: true,
  version: "1.25",
  enabledClusterLogTypes: [
    "api",
    "audit",
    "authenticator",
    "controllerManager",
    "scheduler",
  ],
  vpcId: myvpc.vpcId,
  subnetIds: myvpc.publicSubnetIds,
  clusterSecurityGroup: eksclustersecuritygroup,
});

// Generate a kubeconfig for the EKS cluster.
const mykubeconfig = mycluster.kubeconfig;

export const kubeconfig = pulumi.secret(mykubeconfig);

// ##############################################################
// ##########         On-Cluster Setup         ##################
// ##############################################################

// Create the k8s provider
const k8sProvider = new k8s.Provider(`${my_name}-k8sprovider`, {
  kubeconfig: kubeconfig.apply(JSON.stringify),
});

// create the namespace for poddisruption budget
const mynamespace = new k8s.core.v1.Namespace(
  `${my_name}-namespace`,
  {},

  { provider: k8sProvider, dependsOn: [mycluster] } // Use this for ~/.kube/config
);

// export the namespace name
export const mynamespace_name = mynamespace.metadata.name;

// Create a deployment for the poddisruption budget to target.
const myapp = new k8s.apps.v1.Deployment(
  `${my_name}-app`,
  {
    metadata: { namespace: mynamespace.metadata.name },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: {
          app: "myapp",
        },
      },
      template: {
        metadata: {
          labels: {
            app: "myapp",
          },
        },
        spec: {
          containers: [
            {
              name: "myapp",
              image: "alpine:latest",
              command: [ "/bin/sh", "-c", "--" ],
              args: [ "while true; do sleep 30; done;" ],
              ports: [{ containerPort: 80 }],
            },
          ],
        },
      },
    },
  },
  { provider: k8sProvider, dependsOn: [mynamespace, mycluster] }
);

// ##############################################################
// ##########            Repro Steps            #################
// ##############################################################

// Create the poddisruption budget. This will prevent the node group from updating if the poddisruption budget is not met.
// Delete this resource after the first run when you are trying to re-create the issue.
const pdb = new k8s.policy.v1.PodDisruptionBudget(
  `${my_name}-pdb`,
  {
    metadata: { namespace: mynamespace.metadata.name },
    spec: {
    //   minAvailable: "100%",
      maxUnavailable: "100%",

      selector: {
        matchLabels: {
          app: "myapp",
        },
      },
    },
  },
  { dependsOn: [mynamespace, mycluster], provider: k8sProvider }
);

// export the poddisruption budget name
export const pdb_name = pdb.metadata.name;

// Create launch template for the eks node group.
// This is where a lot of the magic happens.  The launch template is what is used to create the instances in the node group.
const mylaunchTemplate = new aws.ec2.LaunchTemplate(
  `${my_name}-launchtemplate`,
  {
    tags: { Name: `${my_name}-launchtemplate` },
    // instanceType: "t3a.small", // Toggle this instance type with the one below so that the launch template changes versions.
    instanceType: "t3a.nano", // Toggle this instance type with the one above so that the launch template changes versions.
    description:
      "This is the example launch template for the EKS cluster managed node group by User A",
    updateDefaultVersion: true,
    vpcSecurityGroupIds: [eksclustersecuritygroup.id],
  }
);

// export the launch template id and version
export const mylaunchTemplate_id = mylaunchTemplate.id;
export const mylaunchTemplate_version = mylaunchTemplate.latestVersion;

// create the eks node group with the launch template
const eksnodegroup = eks.createManagedNodeGroup(`${my_name}-eksNodeGroup`, {
  cluster: mycluster,
  nodeRole: nodeRole,
  launchTemplate: {
    id: mylaunchTemplate.id,
    version: pulumi.interpolate`${mylaunchTemplate.latestVersion}`,
  },
  scalingConfig: {
    desiredSize: 2,
    maxSize: 8,
    minSize: 2,
  },
});

// export the nodegroup name
export const eksnodegroup_name = eksnodegroup.nodeGroupName;