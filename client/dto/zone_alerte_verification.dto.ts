export interface ZoneAlerteComparaisonDepartement {
  code: string;
  percentageCover: number;
  zoneOutsideDepartement: number;
  zoneOutsideDepartementGeom: any;
  zoneEmptyDepartementGeom: any;
}

export interface ZoneAlerteComparaisonZone {
  currentCode: string;
  futurCode: string;
  areaCover: number;
  areaDifference: number;
  percentageCover: number;
  zoneDifference: any;
}
