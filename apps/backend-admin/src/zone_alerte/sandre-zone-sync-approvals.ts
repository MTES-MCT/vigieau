import { fingerprint } from './sandre-zone-reconciliation';
import { SandreZoneFeature, SandreZoneSnapshot } from './sandre-zone-sync';

export interface SandreApprovedSyncMapping {
  sourceCode: string;
  sourceZoneId: number;
  targetCodes: string[];
  requireTopologicalEquality: boolean;
  effectiveDate: string | null;
  expectedGeometry: {
    sourceGeometryHash: string;
    targetGeometryHashes: string[];
    unionGeometryHash: string;
    sourceCoverage: number;
    targetCoverage: number;
    iou: number;
  } | null;
  minimumGeometry: {
    sourceCoverage: number;
    targetCoverage: number;
    iou: number;
  };
  maximumPairwiseOverlapRatio?: number;
}

export interface SandreApprovedGeometryEvidence {
  sourceGeometryHash: string;
  targetGeometryHashes: string[];
  unionGeometryHash: string;
  sourceCoverage: number;
  targetCoverage: number;
  iou: number;
  pairwiseOverlapRatio: number;
  topologicallyEqual: boolean;
  sourceValid: boolean;
  targetsValid: boolean;
  sourceSrid: number;
  targetsSrid: number;
  sourceType: string;
  targetType: string;
}

export interface SandreApprovedGeometryQueryExecutor {
  query(query: string, parameters?: any[]): Promise<any[]>;
}

export interface SandreMdmZoneExpectation {
  codeSandre: string;
  projectionSha256: string;
  requiredEvolution: {
    typeNid: string;
    date: string;
    comment: string;
  } | null;
}

export interface SandreApprovedSyncSnapshot {
  approvalId: string;
  departmentCode: string;
  snapshotHash: string;
  sourceUpdatedAt: string;
  featureCount: number;
  featureEvidenceFingerprint: string;
  expectedSourceCount: number;
  expectedTargetCount: number;
  mappings: SandreApprovedSyncMapping[];
  mdmRecords: SandreMdmZoneExpectation[];
  mdmNomenclature: SandreMdmNomenclatureExpectation | null;
}

export interface SandreMdmNomenclatureExpectation {
  nid: string;
  nomenclatureCode: string;
  title: string;
  code: string;
  mnemonic: string;
  projectionSha256: string;
}

const DEFAULT_MAXIMUM_PAIRWISE_OVERLAP_RATIO = 1e-10;
const ABSOLUTE_MAXIMUM_PAIRWISE_OVERLAP_RATIO = 2e-9;

type SandreApprovedEquivalentMappingTuple = readonly [
  sourceCode: string,
  sourceZoneId: number,
  targetCode: string,
  sourceGeometryHash: string,
  targetGeometryHash: string,
  unionGeometryHash: string,
  sourceCoverage: number,
  targetCoverage: number,
  iou: number,
];

const DEPARTMENT_24_EQUIVALENT_MAPPINGS: readonly SandreApprovedEquivalentMappingTuple[] =
  [
    [
      '1029',
      12098,
      '4077',
      'c887321ceb9a1184d5b874a7ef42877a',
      '165b5b8e4504775213a1805f930f6501',
      '22b44390a9b7d459b05acbd79bc4a1f8',
      0.9999999932936506,
      0.9999999939499236,
      0.9999999872435719,
    ],
    [
      '1030',
      12099,
      '4080',
      '6867e33b5043f01ef2d53e866339ab9d',
      '96d5dc053f1750c7be0534e2bec69b60',
      '3570913f59115760e08d0555dad6fa41',
      0.9999999970091461,
      0.9999999969652732,
      0.999999993974421,
    ],
    [
      '1032',
      12102,
      '4065',
      'a38294d0d0dd36c9000390da8d1ab96b',
      'b47dd9cb26ae0400b733dfedb432a2da',
      '1a65baccb685fb0ade0d201d08cb9412',
      0.9999999938724111,
      0.9999999940544043,
      0.999999987926816,
    ],
    [
      '1033',
      12104,
      '4115',
      'da0821225897fbdbafeb986a5a6eec73',
      '4aa806ce578b1d3b54bc0762a3579436',
      'cb9f6fbadd51c2ba3402b83812efbc48',
      0.9999925920889376,
      0.9999929548255633,
      0.9999855470188841,
    ],
    [
      '1034',
      12107,
      '4066',
      '04cdc3d0ae3064e2092e8814743ad71d',
      '4de90509c76c3eb710f86737352424c6',
      'e0fdec44755ec7e3a12332f212268b4e',
      0.9999999962191827,
      0.9999999964171818,
      0.9999999926363773,
    ],
    [
      '1035',
      12110,
      '4112',
      '0f228ef4cb6d3d0683f52f9b5b2a0fe9',
      '711ab6281e8227df010cb4d34d8c613c',
      '0b548d0f643f17f791a6b44210acf0f1',
      0.9999999967908926,
      0.9999999957855784,
      0.9999999925764711,
    ],
    [
      '1037',
      12112,
      '4111',
      'b19a7929c2dd2ff4fb0a38f730e73848',
      'a2c8a8b7f201a547d9fbaa7fd10fc045',
      'c7ef838672793190041bb016735c1157',
      0.9999999958688482,
      0.9999999959899296,
      0.9999999918587719,
    ],
    [
      '1040',
      12115,
      '4090',
      'a026df5e1c70cfb5d05bbf4c62d0b746',
      '0cb1ed013ca4d7ca39f93e5f9f5173fe',
      '7040c75afe185a87931d2c44c29b23a6',
      0.9999999919954794,
      0.9999999914977582,
      0.999999983493232,
    ],
    [
      '1041',
      12116,
      '4109',
      '722a1c239eb2fbc2d63ffe6194b80583',
      '66b6c678728f38e07a50b25740bc2374',
      'b383f6e760f468d3ab884a551f2ad9a1',
      0.9999999965009743,
      0.9999999960439534,
      0.9999999925449298,
    ],
    [
      '1045',
      12124,
      '4071',
      'f8c0daac5e9af00d2e1e349928847b80',
      'd75997c4df4e0a2e8ff6bca5f59bad75',
      'fe01c0b2bb769776f2581280d316a20d',
      0.9999999946160364,
      0.99999999310258,
      0.9999999877186307,
    ],
    [
      '1048',
      12131,
      '4072',
      '9c5bbad8179c24ae5da74e45607736d4',
      '70e918272d63cacf7eae75210e30cee7',
      '4ca9a0ece765e1608a026b96a0a6f3d0',
      0.9999999969625526,
      0.9999999968009183,
      0.9999999937634689,
    ],
    [
      '1049',
      12132,
      '4073',
      '3a52d0078143837045ce901c1d56853e',
      '961a21a1ac22407d74e18e4faa846a50',
      '1a01cd20dbb4e16431db1677f9c88827',
      0.9999999963325245,
      0.9999999964386831,
      0.9999999927712078,
    ],
    [
      '1050',
      12135,
      '4074',
      '352ef02746344c7a7da2cdeb4861bad7',
      'cb4e1252f127a6bdf4080e16583f79c9',
      '714284d665fa30c0f534418a99b59aa7',
      0.9999999953937504,
      0.9999999953921883,
      0.9999999907859367,
    ],
    [
      '1051',
      12136,
      '4075',
      'e0ad8e8306a2e83efdc0cda83f3815b3',
      'e9b123a10c7a02d5f3cc0c77cc843f1f',
      '139dd5218191e0d3c14e46dbcecac0bb',
      0.9999999951043576,
      0.9999999951420294,
      0.9999999902463849,
    ],
    [
      '1052',
      12137,
      '4110',
      '3bd806da881d44e2671b1bf861af39bd',
      '26d91626c6cd4e5bc5abf1c3fc072bea',
      '2ff06a9829b9c14e529d8482728e2aa9',
      0.9999999906429151,
      0.9999999892972723,
      0.9999999799401892,
    ],
    [
      '1053',
      12139,
      '4107',
      '7e02f165ed856feb7940d13099b7b14c',
      '0a239a16cb6e584b89427bc60de86485',
      '077a48a48364aa7cbc20dc05fc102bfa',
      0.9999999959610518,
      0.999999996008538,
      0.9999999919695906,
    ],
    [
      '1054',
      12140,
      '4108',
      '201e3382aab5750bf105608b446fd74a',
      '06aefa11bcfc41ab7b40b2a1007af319',
      '9d8e6724356a1664ba27a45bcf8532d8',
      0.9999999969378257,
      0.9999999970664307,
      0.9999999940042508,
    ],
    [
      '1531',
      12111,
      '4098',
      'f9d4f63ea45b93aa7797b5af7de78f84',
      'b2655b6baed5a811a65f940ffef2af86',
      '7041586b65a12b4c7e0259293453398a',
      0.9999999945596113,
      0.9999999960255271,
      0.9999999905851427,
    ],
    [
      '1540',
      12092,
      '4063',
      '309321d078d06de7db72d72ca2ed1a5d',
      '5b3facd17ce8b1108d260579025f8d36',
      'a905806a71f741391acaec04601d0209',
      0.9999999930311261,
      0.9999999922219106,
      0.9999999852530382,
    ],
    [
      '1541',
      12093,
      '4083',
      '5815386e1b42fa7091d1a55c47a75ba7',
      'ad43d1352cdacafce59828152260587e',
      '1b2cce6de8d9dda876aaa7d7882b23d3',
      0.9999999957143303,
      0.9999999944707927,
      0.9999999901851216,
    ],
    [
      '1542',
      12094,
      '4064',
      'd2645ff10f587e8c870f727355cc78c1',
      '5c8cc44913ec0cfae6643a1958480e1b',
      '4bff68e07b760ab16660f90990b38cf6',
      0.9999999951940439,
      0.9999999953286551,
      0.9999999905226993,
    ],
    [
      '1543',
      12095,
      '4079',
      'cdafcf1b880f9ea93dd2da1fbf0cea22',
      '20432326646abf545383ccfb87fb9729',
      'da3d065894e0f783ff60cf1a4b96b7df',
      0.9999999969705736,
      0.9999999970732096,
      0.9999999940437796,
    ],
    [
      '1545',
      12096,
      '4069',
      '2d7080396a4cacf97677f32c83fda8e6',
      '49b6e7a1897e1b50bec7fc9443a284c9',
      '702979dec2d8c117559f616ea30931d2',
      0.9999999962865106,
      0.9999999964023488,
      0.9999999926888644,
    ],
    [
      '1547',
      12100,
      '4081',
      '87a5687589c8f9401c0674bd233d0dbc',
      'df2d7d2841d05b1e5a7b2351138658e5',
      'c9c4b22abac14493f9ff388059441929',
      0.9999999945895516,
      0.9999999940289448,
      0.9999999886184927,
    ],
    [
      '1548',
      12101,
      '4082',
      '6a8f2451841cfbc603f83ab3733ebe10',
      '5092920acbb770786f5ef894ab76c54f',
      '4586c04a3964257659c4bfeaeaeb26ac',
      0.9999999936450428,
      0.9999999945927078,
      0.9999999882377452,
    ],
    [
      '1549',
      12103,
      '4106',
      'c66123bbb6ce66c542d45d847140d55d',
      '09e19510aff7ef84531effa478a30294',
      'cd086f55d8dbd00a10f87d4f46b2dcd8',
      0.9999999973256624,
      0.9999999968986931,
      0.9999999942243541,
    ],
    [
      '1550',
      12105,
      '4084',
      '3f184b55701a49b7b583f9ba51d9c9a6',
      '16725423151ad45a7f2ac3beab15ffb4',
      'b3286b560dfb0d91998d9181233c96a9',
      0.9999999962950337,
      0.9999999952044847,
      0.9999999914995207,
    ],
    [
      '1551',
      12106,
      '4085',
      '1bd52b5bbb6cc6ececa816eda39a4922',
      'f18055fd0acc35454512dd0a3b1d883e',
      '5b6ecf83542e83eef15ee0bfcac15ba1',
      0.9999999932010931,
      0.9999999948506414,
      0.9999999880517395,
    ],
    [
      '1552',
      12108,
      '4086',
      '8119fd14e2028913e8b9c40eb68678c1',
      '251392234ab900b11a7f721aa26d8424',
      '823e53b0df4a17907f3841f924946772',
      0.999999996428428,
      0.9999999970291673,
      0.999999993457601,
    ],
    [
      '1553',
      12109,
      '4087',
      '8eabd72b503223562546f4a06cc46172',
      'a8e8e530aeb237d57e6b9f52764d519e',
      '1efb7f1d3e1dd8c0955620f9fe41de58',
      0.9999999949999266,
      0.9999999964609043,
      0.9999999914608398,
    ],
    [
      '1554',
      12113,
      '4088',
      'abc1152060a9ffeb9719c0ca1b7f03c3',
      '5355d6d76bdb2ce833bed4af50e20478',
      '00d012fd4c25b2b09628b3f88666f40e',
      0.9999999973603992,
      0.9999999963343074,
      0.9999999936947083,
    ],
    [
      '1555',
      12114,
      '4089',
      '3748ea93b61a219b3ec1fc8d469a7480',
      'c25b7495c6fc686b450d6578fcc9f4ff',
      'a104ea35a8d19f77624deeda4b9d0232',
      0.9999999952860602,
      0.9999999946032871,
      0.9999999898893381,
    ],
    [
      '1556',
      12121,
      '4091',
      '97917acca17b0a454901d52d3b42eced',
      'e3b1a22533dd20bbcc3ea60ca1c17046',
      '6aa5625fd275172a0828056f6fdceb09',
      0.999999995973378,
      0.9999999951450085,
      0.9999999911183839,
    ],
    [
      '1557',
      12117,
      '4092',
      '7b0f33b33e874568deaef78e9f287377',
      '4275ba0a1854fc4c4b102357f0cb4285',
      '8f182c4b214338074282c12157018969',
      0.9999999920405493,
      0.9999999947355319,
      0.9999999867760674,
    ],
    [
      '1558',
      12118,
      '4113',
      '4438727b9822b3f59b2a56517bcb3d2b',
      '038fec6dd48f835d9bf6075cbfa157f2',
      'fb3437a4f11b35830f51885cd86239cc',
      0.999999995119655,
      0.9999999953470101,
      0.9999999904666577,
    ],
    [
      '1559',
      12119,
      '4094',
      '630532b1a9a2c391255e8271aac94757',
      'ab86ffeddaf5893710140cee094444a5',
      '087e8e8f293f56907ceaecb6f0775e8e',
      0.999999995579371,
      0.9999999965873191,
      0.9999999921666882,
    ],
    [
      '1561',
      12120,
      '4095',
      'f49278db23943ad900c5ec47e567d95b',
      'b6d080f4733a47df76752e3cdf986925',
      '1741c0da316f3e609dfbf30e5554f01c',
      0.9999999965583277,
      0.9999999955745249,
      0.9999999921328582,
    ],
    [
      '1562',
      12127,
      '4093',
      'd814a164712425ec3248f500aa4517d0',
      'af6be2ef45be9959c2b7171e24af8a1f',
      '426f6b332ab8b5f622a2e2b39401f649',
      0.9999999938712711,
      0.9999999935958228,
      0.9999999874670857,
    ],
    [
      '1563',
      12122,
      '4097',
      'e45510482d0c7339c222113a13df35f8',
      '6e029e58fad3cb29464c6fa1f78c8f5d',
      'e1773f2c415c8b1a5f42a0f4198c7240',
      0.999999994775716,
      0.9999999938358104,
      0.9999999886115316,
    ],
    [
      '1564',
      12128,
      '4096',
      'c735f0808a9e1574d27380db7116fd7e',
      'b28cf67e822fbf0fdeda8448127b4658',
      'f4646d9005f605c76d380ceead435889',
      0.9999999962360459,
      0.9999999957126022,
      0.9999999919486513,
    ],
    [
      '1565',
      12123,
      '4099',
      'e55cd46dd0a1963921bf46f5b61bdc07',
      '34b364fdabe1ea41b72577334ec17197',
      '8d3190768128ebbf0c4f81936867fc62',
      0.9999999951550747,
      0.9999999951954857,
      0.9999999903505631,
    ],
    [
      '1567',
      12125,
      '4100',
      '2c6fc929e9b82c08e0b432e283387304',
      '6c5e93f7eb9b077ba769e392cd509506',
      '64cfbc447c1bab222841a9f60e84fcbf',
      0.9999999956672135,
      0.9999999965557759,
      0.9999999922229919,
    ],
    [
      '1568',
      12126,
      '4070',
      '694ea9cbdb44849ee5bc601bae1ce2cd',
      'ba63e866ee6e8b6f9b6e4392e866a3f5',
      '0a35c3b1644f4150b181571a7ed9b03c',
      0.9999999961963644,
      0.9999999966188657,
      0.9999999928152318,
    ],
    [
      '1570',
      12129,
      '4101',
      '24484bbe0c30a40f7839b6351cb82e30',
      '7439c44d20e14791e7d384e530b145a6',
      'c7f5850d9cb5aa0ff212c1654e1e457b',
      0.999999996658215,
      0.99999999676075,
      0.9999999934189658,
    ],
    [
      '1572',
      12130,
      '4102',
      'b200e47a7e19dc33617c591cce539d5f',
      '3ac4adc2e6288a4ce3ad5822c0c9e6b2',
      'f0a3f5b55b2959f8d4b5dd0f8e22fe0f',
      0.9999999957551169,
      0.9999999957246899,
      0.9999999914798083,
    ],
    [
      '1575',
      12133,
      '4103',
      '24ca3334d37fd7c4c411df4e5cf7a3d0',
      '36b9a0bf9a3816cea7cea91bb65b0b53',
      '54737e68ab4016e0e1c045d646f3f792',
      0.9999999968338932,
      0.9999999967197073,
      0.9999999935535956,
    ],
    [
      '1576',
      12134,
      '4104',
      '1d7b3b0d9874b3a4b228ea2e563db8b3',
      '70b6dcc7370f20abeafb1a9a4904a8f7',
      'a3f7b0af5b213f4819314b586b2e6182',
      0.9999999946081587,
      0.9999999938303233,
      0.9999999884384896,
    ],
    [
      '1577',
      12138,
      '4105',
      'bfb9c5242028410ac8e8fda9bc0d236c',
      '3a69b0e13f741a8af348a3fb857ee9d0',
      'dddc6bd6b4932c3d4c97712bcb6ab46d',
      0.9999999679499021,
      0.9999999814977438,
      0.9999999494476741,
    ],
    [
      '1578',
      12141,
      '4068',
      '3ac7153de5e13edd0f91c3a702006cf3',
      '403b3f0636382135637fe28ab7829016',
      '645ee885a97ec058e8d297e31fa999c8',
      0.9999999960443535,
      0.9999999960156233,
      0.9999999920599764,
    ],
    [
      '1579',
      12142,
      '4076',
      '435d9311b5667374a5ad56034641c2f2',
      '088edd978299d311012ae33e966c6e30',
      'f924dcc81b551dba568e48c3fb6fa897',
      0.9999999919997797,
      0.9999999892213569,
      0.9999999812211544,
    ],
    [
      '1580',
      12143,
      '4067',
      '1c259a2e357b80131063aed6b4ce9a41',
      'c6e738107fae86abd8522dfe34f23994',
      '8834f75b63b1759a4a8e26f3a1672e45',
      0.9999999882500139,
      0.9999999858419684,
      0.999999974092,
    ],
    [
      '3934',
      16712,
      '4078',
      'f61a86d0796244f756277526bf152b71',
      'f1fb72ff5dc97ba299743b00acdf1329',
      '1a80005d444f677ab157bc46fc3d7cdf',
      0.9999999890244227,
      0.999999989949151,
      0.9999999789735821,
    ],
    [
      '3935',
      16713,
      '4114',
      '924eb316fc4a0f6305b229596bfe101c',
      'dfd97255231247f132e6a3f2824d3525',
      'e537d189dfdf6c74c798578eac14cb8a',
      0.9999999950222872,
      0.9999999950480444,
      0.9999999900703325,
    ],
  ];

const DEPARTMENT_24_MAPPINGS: SandreApprovedSyncMapping[] = [
  partitionMapping('1028', 12097, ['4116', '4117'], '2026-08-05', {
    sourceGeometryHash: 'f70d2c378906e67650d40b6cd8e14690',
    targetGeometryHashes: [
      '93f4317d20505889d136a35ff5d8015f',
      'd21eee234aa3e64316c17775cc6f1f47',
    ],
    unionGeometryHash: '28ce8d6311c791c0cf3eebb696e1d59f',
    sourceCoverage: 0.9999922468432514,
    targetCoverage: 0.9999929950328335,
    iou: 0.9999852419847116,
  }),
  ...DEPARTMENT_24_EQUIVALENT_MAPPINGS.map((item) =>
    equivalentMapping(...item),
  ),
];

export const SANDRE_APPROVED_SYNC_SNAPSHOTS: readonly SandreApprovedSyncSnapshot[] =
  Object.freeze([
    approval({
      approvalId: 'dep24-snapshot-b8ea0408',
      departmentCode: '24',
      snapshotHash:
        'b8ea0408f5ae1910f1ff51d68e6ad81a6f46f08cb4df5d84c0fff3ad624f86b0',
      sourceUpdatedAt: '2026-08-05',
      featureCount: 110,
      featureEvidenceFingerprint:
        '0b11da69b6e8f526a3c543078d8c926d9a18f8f85ce5cc9ab78eb0f86fd0aac1',
      expectedSourceCount: 54,
      expectedTargetCount: 55,
      mappings: DEPARTMENT_24_MAPPINGS,
      mdmRecords: [],
      mdmNomenclature: null,
    }),
    approval({
      approvalId: 'dep85-split-355-snapshot-934aa655',
      departmentCode: '85',
      snapshotHash:
        '934aa655f60af4ee61f5ba533b365b4ba75dc37671f95ab2b73c99a03b008324',
      sourceUpdatedAt: '2026-06-30',
      featureCount: 26,
      featureEvidenceFingerprint:
        'df2652912748bb7847e7d67c49b2647c6624ad13818874089d3a49c20961248f',
      expectedSourceCount: 1,
      expectedTargetCount: 2,
      mappings: [
        partitionMapping(
          '355',
          10582,
          ['3947', '3948'],
          '2026-06-30',
          {
            sourceGeometryHash: '71d342c49c82a7da369c288f6a3d672e',
            targetGeometryHashes: [
              'e5f1c73a7d9322e889f65d838a176a47',
              '73d4b862c4f9972f6d8b2d6f85f0085b',
            ],
            unionGeometryHash: '6e8a2ec00f197fcdb664122695102ffc',
            sourceCoverage: 0.9999888461090162,
            targetCoverage: 0.9999894571755797,
            iou: 0.9999783035197829,
          },
          2e-9,
        ),
      ],
      mdmRecords: [
        {
          codeSandre: '355',
          projectionSha256:
            'b7b16963402b459df4f882bc18962a284167d725fd05e718ca1ac68666b97504',
          requiredEvolution: null,
        },
        {
          codeSandre: '3947',
          projectionSha256:
            '098dd3dc60cfdda243c57446c3ae65239236f7fc7e4b6bc3bc783e262497d2fa',
          requiredEvolution: {
            typeNid: '282836',
            date: '2026-06-30 00:00:00',
            comment: 'Division de la ZAS 355',
          },
        },
        {
          codeSandre: '3948',
          projectionSha256:
            '7ae78c09c40975d09e3ce51bc8b7db433fd0651b178d501e38a0e112f8f59b06',
          requiredEvolution: {
            typeNid: '282836',
            date: '2026-06-30 00:00:00',
            comment: 'Division de la ZAS 355',
          },
        },
      ],
      mdmNomenclature: {
        nid: '282836',
        nomenclatureCode: '590',
        title: 'Création',
        code: '7',
        mnemonic: 'Création',
        projectionSha256:
          'a14aea447a72ba382e3645c02b89dda903c38f2b147cab46b605ff455387020d',
      },
    }),
  ]);

export function findSandreApprovedSyncSnapshot(
  departmentCode: string,
  snapshot: SandreZoneSnapshot,
): SandreApprovedSyncSnapshot | null {
  const approval =
    SANDRE_APPROVED_SYNC_SNAPSHOTS.find(
      (candidate) => candidate.departmentCode === departmentCode,
    ) ?? null;
  if (
    !approval ||
    snapshot.snapshotHash !== approval.snapshotHash ||
    snapshot.sourceUpdatedAt !== approval.sourceUpdatedAt ||
    snapshot.featureCount !== approval.featureCount
  ) {
    return null;
  }

  const featureEvidence = sandreSnapshotFeatureEvidence(snapshot);
  if (fingerprint(featureEvidence) !== approval.featureEvidenceFingerprint) {
    throw new Error(
      `Approved Sandre feature evidence changed for department ${departmentCode}`,
    );
  }
  const featuresByCode = new Map(
    snapshot.features.map((feature) => [feature.codeSandre, feature]),
  );
  for (const item of approval.mappings) {
    assertFeature(featuresByCode.get(item.sourceCode), item.sourceCode, 'Gelé');
    for (const targetCode of item.targetCodes) {
      assertFeature(featuresByCode.get(targetCode), targetCode, 'Validé');
    }
  }
  return approval;
}

export function sandreSnapshotFeatureEvidence(
  snapshot: SandreZoneSnapshot,
): Array<{
  codeSandre: string;
  gid: number;
  status: string;
  type: string;
  payloadHash: string;
  geometryHash: string;
}> {
  return snapshot.features
    .map((feature) => ({
      codeSandre: feature.codeSandre,
      gid: feature.gid,
      status: feature.status,
      type: feature.type,
      payloadHash: feature.payloadHash,
      geometryHash: fingerprint({
        type: feature.geometry?.type,
        coordinates: feature.geometry?.coordinates,
      }),
    }))
    .sort((left, right) => left.codeSandre.localeCompare(right.codeSandre));
}

export async function auditSandreApprovedSyncGeometry(
  executor: SandreApprovedGeometryQueryExecutor,
  mapping: SandreApprovedSyncMapping,
  targetFeatures: SandreZoneFeature[],
): Promise<SandreApprovedGeometryEvidence> {
  const maximumPairwiseOverlapRatio =
    resolveMaximumPairwiseOverlapRatio(mapping);
  if (
    targetFeatures.length !== mapping.targetCodes.length ||
    targetFeatures.some(
      (feature) => !mapping.targetCodes.includes(feature.codeSandre),
    )
  ) {
    throw new Error(
      `Approved Sandre targets changed for source ${mapping.sourceCode}`,
    );
  }
  const [row] = await executor.query(
    `
      WITH source AS (
        SELECT geom
        FROM zone_alerte
        WHERE id = $1
      ), target_items AS (
        SELECT
          item.code,
          ST_Multi(ST_CollectionExtract(ST_MakeValid(
            ST_SetSRID(ST_GeomFromGeoJSON(item.geometry::text), 4326)
          ), 3)) AS geom
        FROM jsonb_to_recordset($2::jsonb)
          AS item(code text, geometry jsonb)
      ), targets AS (
        SELECT
          ST_UnaryUnion(ST_Collect(geom)) AS geom,
          array_agg(md5(ST_AsEWKB(geom)) ORDER BY code) AS hashes,
          bool_and(ST_IsValid(geom)) AS valid,
          min(ST_SRID(geom)) AS min_srid,
          max(ST_SRID(geom)) AS max_srid
        FROM target_items
      ), overlap AS (
        SELECT COALESCE(sum(ST_Area(ST_Intersection(left_item.geom, right_item.geom))), 0)
          AS area
        FROM target_items left_item
        JOIN target_items right_item ON left_item.code < right_item.code
      ), measured AS (
        SELECT
          source.geom AS source_geom,
          targets.geom AS target_geom,
          targets.hashes,
          targets.valid AS targets_valid,
          targets.min_srid,
          targets.max_srid,
          overlap.area AS overlap_area,
          ST_Area(source.geom) AS source_area,
          ST_Area(targets.geom) AS target_area,
          ST_Area(ST_Intersection(source.geom, targets.geom)) AS intersection_area,
          ST_Area(ST_Union(source.geom, targets.geom)) AS union_area
        FROM source, targets, overlap
      )
      SELECT
        md5(ST_AsEWKB(source_geom)) AS "sourceGeometryHash",
        hashes AS "targetGeometryHashes",
        md5(ST_AsEWKB(target_geom)) AS "unionGeometryHash",
        CASE WHEN source_area = 0 THEN 0
          ELSE intersection_area / source_area END::text AS "sourceCoverage",
        CASE WHEN target_area = 0 THEN 0
          ELSE intersection_area / target_area END::text AS "targetCoverage",
        CASE WHEN union_area = 0 THEN 0
          ELSE intersection_area / union_area END::text AS iou,
        CASE WHEN target_area = 0 THEN 0
          ELSE overlap_area / target_area END::text AS "pairwiseOverlapRatio",
        ST_Equals(source_geom, target_geom) AS "topologicallyEqual",
        ST_IsValid(source_geom) AS "sourceValid",
        targets_valid AS "targetsValid",
        ST_SRID(source_geom) AS "sourceSrid",
        CASE WHEN min_srid = max_srid THEN min_srid ELSE NULL END AS "targetsSrid",
        GeometryType(source_geom) AS "sourceType",
        GeometryType(target_geom) AS "targetType"
      FROM measured
    `,
    [
      mapping.sourceZoneId,
      JSON.stringify(
        targetFeatures.map((feature) => ({
          code: feature.codeSandre,
          geometry: feature.geometry,
        })),
      ),
    ],
  );
  if (!row) {
    throw new Error(
      `Approved Sandre source zone ${mapping.sourceZoneId} is missing`,
    );
  }
  const evidence: SandreApprovedGeometryEvidence = {
    sourceGeometryHash: String(row.sourceGeometryHash),
    targetGeometryHashes: row.targetGeometryHashes ?? [],
    unionGeometryHash: String(row.unionGeometryHash),
    sourceCoverage: Number(row.sourceCoverage),
    targetCoverage: Number(row.targetCoverage),
    iou: Number(row.iou),
    pairwiseOverlapRatio: Number(row.pairwiseOverlapRatio),
    topologicallyEqual: row.topologicallyEqual === true,
    sourceValid: row.sourceValid === true,
    targetsValid: row.targetsValid === true,
    sourceSrid: Number(row.sourceSrid),
    targetsSrid: Number(row.targetsSrid),
    sourceType: String(row.sourceType),
    targetType: String(row.targetType),
  };
  const isExactEquivalentMapping = mapping.targetCodes.length === 1;
  if (
    !evidence.sourceValid ||
    !evidence.targetsValid ||
    evidence.sourceSrid !== 4326 ||
    evidence.targetsSrid !== 4326 ||
    !['POLYGON', 'MULTIPOLYGON'].includes(evidence.sourceType) ||
    !['POLYGON', 'MULTIPOLYGON'].includes(evidence.targetType) ||
    evidence.sourceCoverage < mapping.minimumGeometry.sourceCoverage ||
    evidence.targetCoverage < mapping.minimumGeometry.targetCoverage ||
    evidence.iou < mapping.minimumGeometry.iou ||
    !Number.isFinite(evidence.pairwiseOverlapRatio) ||
    evidence.pairwiseOverlapRatio < 0 ||
    evidence.pairwiseOverlapRatio > maximumPairwiseOverlapRatio ||
    (mapping.requireTopologicalEquality && !evidence.topologicallyEqual) ||
    (mapping.expectedGeometry !== null &&
      (evidence.sourceGeometryHash !==
        mapping.expectedGeometry.sourceGeometryHash ||
        evidence.unionGeometryHash !==
          mapping.expectedGeometry.unionGeometryHash ||
        fingerprint(evidence.targetGeometryHashes) !==
          fingerprint(mapping.expectedGeometry.targetGeometryHashes) ||
        (isExactEquivalentMapping &&
          (evidence.sourceCoverage !==
            mapping.expectedGeometry.sourceCoverage ||
            evidence.targetCoverage !==
              mapping.expectedGeometry.targetCoverage ||
            evidence.iou !== mapping.expectedGeometry.iou ||
            evidence.pairwiseOverlapRatio !== 0 ||
            evidence.topologicallyEqual))))
  ) {
    throw new Error(
      `Approved Sandre geometry changed for source ${mapping.sourceCode}`,
    );
  }
  return evidence;
}

export async function assertSandreApprovedMaterializedTargets(
  executor: SandreApprovedGeometryQueryExecutor,
  departmentId: number,
  targets: Array<{
    feature: SandreZoneFeature;
    zoneAlerteId: number;
  }>,
): Promise<void> {
  const rows = await executor.query(
    `
      WITH expected AS (
        SELECT
          item.code,
          item."zoneAlerteId",
          ST_Multi(ST_CollectionExtract(ST_MakeValid(
            ST_SetSRID(ST_GeomFromGeoJSON(item.geometry::text), 4326)
          ), 3)) AS geom
        FROM jsonb_to_recordset($2::jsonb) AS item(
          code text,
          "zoneAlerteId" integer,
          geometry jsonb
        )
      )
      SELECT
        expected.code,
        zone.id AS "zoneAlerteId",
        zone."codeSandre",
        zone.disabled,
        zone.type,
        zone."departementId",
        md5(ST_AsEWKB(zone.geom)) AS "localGeometryHash",
        md5(ST_AsEWKB(expected.geom)) AS "expectedGeometryHash",
        ST_Equals(zone.geom, expected.geom) AS "topologicallyEqual"
      FROM expected
      LEFT JOIN zone_alerte zone
        ON zone.id = expected."zoneAlerteId"
        AND zone."departementId" = $1
      ORDER BY expected.code
    `,
    [
      departmentId,
      JSON.stringify(
        targets.map(({ feature, zoneAlerteId }) => ({
          code: feature.codeSandre,
          zoneAlerteId,
          geometry: feature.geometry,
        })),
      ),
    ],
  );
  if (
    rows.length !== targets.length ||
    rows.some(
      (row) =>
        !Number.isInteger(Number(row.zoneAlerteId)) ||
        row.codeSandre !== row.code ||
        row.disabled !== false ||
        row.type !== 'SUP' ||
        Number(row.departementId) !== departmentId ||
        row.localGeometryHash !== row.expectedGeometryHash ||
        row.topologicallyEqual !== true,
    )
  ) {
    throw new Error('Approved Sandre materialized target geometry changed');
  }
}

function equivalentMapping(
  sourceCode: string,
  sourceZoneId: number,
  targetCode: string,
  sourceGeometryHash: string,
  targetGeometryHash: string,
  unionGeometryHash: string,
  sourceCoverage: number,
  targetCoverage: number,
  iou: number,
): SandreApprovedSyncMapping {
  return {
    sourceCode,
    sourceZoneId,
    targetCodes: [targetCode],
    requireTopologicalEquality: false,
    effectiveDate: null,
    expectedGeometry: {
      sourceGeometryHash,
      targetGeometryHashes: [targetGeometryHash],
      unionGeometryHash,
      sourceCoverage,
      targetCoverage,
      iou,
    },
    minimumGeometry: {
      sourceCoverage,
      targetCoverage,
      iou,
    },
    maximumPairwiseOverlapRatio: 0,
  };
}

function partitionMapping(
  sourceCode: string,
  sourceZoneId: number,
  targetCodes: string[],
  effectiveDate: string,
  expectedGeometry: NonNullable<SandreApprovedSyncMapping['expectedGeometry']>,
  maximumPairwiseOverlapRatio = DEFAULT_MAXIMUM_PAIRWISE_OVERLAP_RATIO,
): SandreApprovedSyncMapping {
  const margin = 1e-7;
  return {
    sourceCode,
    sourceZoneId,
    targetCodes,
    requireTopologicalEquality: false,
    effectiveDate,
    expectedGeometry,
    minimumGeometry: {
      sourceCoverage: expectedGeometry.sourceCoverage - margin,
      targetCoverage: expectedGeometry.targetCoverage - margin,
      iou: expectedGeometry.iou - margin,
    },
    maximumPairwiseOverlapRatio,
  };
}

function resolveMaximumPairwiseOverlapRatio(
  mapping: SandreApprovedSyncMapping,
): number {
  const maximumPairwiseOverlapRatio =
    mapping.maximumPairwiseOverlapRatio ??
    DEFAULT_MAXIMUM_PAIRWISE_OVERLAP_RATIO;
  if (
    !Number.isFinite(maximumPairwiseOverlapRatio) ||
    maximumPairwiseOverlapRatio < 0 ||
    maximumPairwiseOverlapRatio > ABSOLUTE_MAXIMUM_PAIRWISE_OVERLAP_RATIO
  ) {
    throw new Error(
      `Invalid approved Sandre pairwise overlap ratio for source ${mapping.sourceCode}`,
    );
  }
  return maximumPairwiseOverlapRatio;
}

function approval(
  value: SandreApprovedSyncSnapshot,
): SandreApprovedSyncSnapshot {
  const sources = value.mappings.map((item) => item.sourceCode);
  const sourceIds = value.mappings.map((item) => item.sourceZoneId);
  const targets = value.mappings.flatMap((item) => item.targetCodes);
  const approvedCodes = new Set([...sources, ...targets]);
  const mdmCodes = value.mdmRecords.map((record) => record.codeSandre);
  const splitMappings = value.mappings.filter(
    (item) => item.targetCodes.length > 1,
  );
  const mdmEvidenceInvalid =
    value.mdmRecords.length === 0
      ? value.mdmNomenclature !== null
      : !value.mdmNomenclature ||
        new Set(mdmCodes).size !== approvedCodes.size ||
        [...approvedCodes].some((code) => !mdmCodes.includes(code)) ||
        fingerprint({
          nid: value.mdmNomenclature.nid,
          nomenclatureCode: value.mdmNomenclature.nomenclatureCode,
          title: value.mdmNomenclature.title,
          code: value.mdmNomenclature.code,
          mnemonic: value.mdmNomenclature.mnemonic,
        }) !== value.mdmNomenclature.projectionSha256 ||
        splitMappings.some((item) => {
          const source = value.mdmRecords.find(
            (record) => record.codeSandre === item.sourceCode,
          );
          return (
            !source ||
            source.requiredEvolution !== null ||
            item.targetCodes.some((targetCode) => {
              const target = value.mdmRecords.find(
                (record) => record.codeSandre === targetCode,
              );
              return (
                !target?.requiredEvolution ||
                target.requiredEvolution.typeNid !==
                  value.mdmNomenclature!.nid ||
                target.requiredEvolution.date.slice(0, 10) !==
                  item.effectiveDate
              );
            })
          );
        });
  if (
    !/^[a-z0-9-]{8,100}$/.test(value.approvalId) ||
    sources.length !== value.expectedSourceCount ||
    targets.length !== value.expectedTargetCount ||
    new Set(sources).size !== sources.length ||
    new Set(sourceIds).size !== sourceIds.length ||
    new Set(targets).size !== targets.length ||
    sources.some((source) => targets.includes(source)) ||
    value.mappings.some(
      (item) =>
        !Number.isInteger(item.sourceZoneId) ||
        item.sourceZoneId <= 0 ||
        !/^\d{1,32}$/.test(item.sourceCode) ||
        item.targetCodes.length === 0 ||
        item.targetCodes.some((code) => !/^\d{1,32}$/.test(code)) ||
        Object.values(item.minimumGeometry).some(
          (threshold) =>
            !Number.isFinite(threshold) || threshold < 0.9999 || threshold > 1,
        ) ||
        !Number.isFinite(
          item.maximumPairwiseOverlapRatio ??
            DEFAULT_MAXIMUM_PAIRWISE_OVERLAP_RATIO,
        ) ||
        (item.maximumPairwiseOverlapRatio ??
          DEFAULT_MAXIMUM_PAIRWISE_OVERLAP_RATIO) < 0 ||
        (item.maximumPairwiseOverlapRatio ??
          DEFAULT_MAXIMUM_PAIRWISE_OVERLAP_RATIO) >
          ABSOLUTE_MAXIMUM_PAIRWISE_OVERLAP_RATIO ||
        item.requireTopologicalEquality ||
        (item.targetCodes.length === 1
          ? item.effectiveDate !== null ||
            item.maximumPairwiseOverlapRatio !== 0
          : !/^\d{4}-\d{2}-\d{2}$/.test(item.effectiveDate ?? '')) ||
        item.expectedGeometry === null ||
        !/^[a-f0-9]{32}$/.test(item.expectedGeometry.sourceGeometryHash) ||
        !/^[a-f0-9]{32}$/.test(item.expectedGeometry.unionGeometryHash) ||
        item.expectedGeometry.targetGeometryHashes.length !==
          item.targetCodes.length ||
        item.expectedGeometry.targetGeometryHashes.some(
          (hash) => !/^[a-f0-9]{32}$/.test(hash),
        ) ||
        Object.values({
          sourceCoverage: item.expectedGeometry.sourceCoverage,
          targetCoverage: item.expectedGeometry.targetCoverage,
          iou: item.expectedGeometry.iou,
        }).some(
          (observed) =>
            !Number.isFinite(observed) || observed < 0.9999 || observed > 1,
        ) ||
        (['sourceCoverage', 'targetCoverage', 'iou'] as const).some(
          (key) =>
            item.minimumGeometry[key] > item.expectedGeometry![key] ||
            item.expectedGeometry![key] - item.minimumGeometry[key] > 1e-7 ||
            (item.targetCodes.length === 1 &&
              item.minimumGeometry[key] !== item.expectedGeometry![key]),
        ),
    ) ||
    new Set(mdmCodes).size !== mdmCodes.length ||
    mdmEvidenceInvalid ||
    value.mdmRecords.some(
      (record) =>
        !approvedCodes.has(record.codeSandre) ||
        !/^[a-f0-9]{64}$/.test(record.projectionSha256) ||
        (record.requiredEvolution !== null &&
          (!/^\d+$/.test(record.requiredEvolution.typeNid) ||
            !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(
              record.requiredEvolution.date,
            ) ||
            record.requiredEvolution.comment.length === 0 ||
            record.requiredEvolution.comment.length > 500)),
    ) ||
    (value.mdmNomenclature !== null &&
      (!/^\d+$/.test(value.mdmNomenclature.nid) ||
        !/^\d+$/.test(value.mdmNomenclature.nomenclatureCode) ||
        !/^\d+$/.test(value.mdmNomenclature.code) ||
        value.mdmNomenclature.title.length === 0 ||
        value.mdmNomenclature.mnemonic.length === 0 ||
        !/^[a-f0-9]{64}$/.test(value.mdmNomenclature.projectionSha256))) ||
    !/^[a-f0-9]{64}$/.test(value.snapshotHash) ||
    !/^[a-f0-9]{64}$/.test(value.featureEvidenceFingerprint)
  ) {
    throw new Error(
      `Invalid Sandre sync approval for department ${value.departmentCode}`,
    );
  }
  return Object.freeze({
    ...value,
    mappings: Object.freeze(
      value.mappings.map((item) =>
        Object.freeze({
          ...item,
          targetCodes: Object.freeze([...item.targetCodes]) as string[],
          minimumGeometry: Object.freeze({ ...item.minimumGeometry }),
          expectedGeometry: item.expectedGeometry
            ? Object.freeze({
                ...item.expectedGeometry,
                targetGeometryHashes: Object.freeze([
                  ...item.expectedGeometry.targetGeometryHashes,
                ]) as string[],
              })
            : null,
        }),
      ),
    ) as SandreApprovedSyncMapping[],
    mdmRecords: Object.freeze(
      value.mdmRecords.map((record) =>
        Object.freeze({
          ...record,
          requiredEvolution: record.requiredEvolution
            ? Object.freeze({ ...record.requiredEvolution })
            : null,
        }),
      ),
    ) as SandreMdmZoneExpectation[],
    mdmNomenclature: value.mdmNomenclature
      ? Object.freeze({ ...value.mdmNomenclature })
      : null,
  });
}

function assertFeature(
  feature: SandreZoneFeature | undefined,
  expectedCode: string,
  expectedStatus: SandreZoneFeature['status'],
): void {
  if (
    !feature ||
    feature.codeSandre !== expectedCode ||
    feature.status !== expectedStatus ||
    feature.type !== 'SUP'
  ) {
    throw new Error(
      `Approved Sandre feature ${expectedCode}/${expectedStatus} is missing`,
    );
  }
}
